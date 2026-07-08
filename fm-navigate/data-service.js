/* ============================================================
   FM Navigate — data service (localStorage  ←→  Supabase)
   ------------------------------------------------------------
   Single source of truth = ONE "workspace" row holding the whole
   tasks array as jsonb. Both reads and writes use Supabase Auth: a
   signed-in user reads the row, and the EDITOR account writes it
   directly (RLS locks UPDATE to that user's id — no password gate).

   window.dataService:
     backend                 'local' | 'supabase'
     ready                   true when supabase creds present
     loadTasks()             -> Promise<task[]>
     saveTasks(tasks)        -> Promise<{ok, error?}>  (remote only; needs editor session)
     subscribe(cb)           -> unsubscribe fn (realtime; ignores own writes)
     signIn / signOut / getUser / onAuth   (Supabase Auth)
     listResources / addResource / deleteResource  (private vault, per-user RLS)
   ============================================================ */
(function () {
  var CFG = window.APP_CONFIG || {};
  var BACKEND = CFG.DATA_BACKEND === 'supabase' ? 'supabase' : 'local';
  var URL = CFG.SUPABASE_URL || '';
  var ANON = CFG.SUPABASE_ANON_KEY || '';
  var HAS_CREDS = !!(URL && ANON);

  var CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var _client = null;
  var _lastUpdatedAt = null;
  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* The whole workspace is ONE versioned, extensible document stored in the
     'main' row's jsonb column:
       { version, metadata: {...}, data: { tasks, deliverables, weeks, ... } }
     Every feature is just a key under `data` — adding one needs NO persistence
     change, no new row, no seeding, no RLS. Migration is EXPLICIT and version-
     gated: a legacy shape is upgraded once, saved, and then never re-detected.
       • bare ARRAY            → v1 legacy (tasks+deliverables blob, split by kind)
       • flat { tasks, ... }   → v1 legacy (pre-version object)
       • { version>=2, data }  → current; left untouched (no migration) */
  var SCHEMA_VERSION = 2;
  var APP_VERSION = (CFG.APP_VERSION) || '0.9.x';

  // VALIDATION/normalization: guarantee the required structure exists so a UI
  // bug can never persist an invalid document. Keeps all existing data keys
  // (so future features survive) and defaults the known core ones if absent.
  function ensureData(data) {
    var d = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    return {
      ...d, // preserve everything else (goals, notes, settings, …) verbatim …
      // … then enforce the core keys so a bad value can never be persisted.
      tasks: Array.isArray(d.tasks) ? d.tasks : [],
      deliverables: Array.isArray(d.deliverables) ? d.deliverables : [],
      weeks: Array.isArray(d.weeks) ? d.weeks : [],
      kpiScores: (d.kpiScores && typeof d.kpiScores === 'object') ? d.kpiScores : {},
    };
  }

  // Wrap any stored value into a versioned envelope at its lowest known version.
  // A versioned object is taken as-is; anything else is legacy and treated as v1.
  function toEnvelope(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.version >= 1 && raw.data) {
      return { version: raw.version, metadata: raw.metadata || {}, data: raw.data || {} };
    }
    var data;
    if (Array.isArray(raw)) {
      data = {
        tasks: raw.filter(function (r) { return r && r.kind !== 'deliverable'; }),
        deliverables: raw.filter(function (r) { return r && r.kind === 'deliverable'; }),
      };
    } else if (raw && typeof raw === 'object') {
      data = { tasks: raw.tasks, deliverables: raw.deliverables, weeks: raw.weeks, kpiScores: raw.kpiScores };
    } else {
      data = {};
    }
    return { version: 1, metadata: {}, data: data };
  }

  // MIGRATION REGISTRY: migrations[n] upgrades a v(n) doc to v(n+1). Adding a
  // future schema bump = add an entry; the loop below applies them in order.
  var MIGRATIONS = {
    1: function (doc) { // v1 → v2: introduce the metadata block
      var now = new Date().toISOString();
      return {
        version: 2,
        metadata: Object.assign({ createdAt: now, migratedAt: now, appVersion: APP_VERSION }, doc.metadata, { updatedAt: now }),
        data: doc.data,
      };
    },
  };

  // Returns { doc, migrated }. Steps the document up through the registry until
  // it reaches SCHEMA_VERSION. `migrated` is true only when an upgrade ran, so
  // the caller can persist immediately and stop relying on legacy detection.
  function migrateWorkspace(raw) {
    var doc = toEnvelope(raw);
    var migrated = false;
    while (doc.version < SCHEMA_VERSION && MIGRATIONS[doc.version]) {
      doc = MIGRATIONS[doc.version](doc);
      migrated = true;
    }
    doc.data = ensureData(doc.data); // validate structure
    return { doc: doc, migrated: migrated };
  }

  // Flatten { doc, migrated } into the shape the app consumes.
  function _withFlag(m) {
    return { version: m.doc.version, metadata: m.doc.metadata, data: m.doc.data, migrated: m.migrated };
  }

  // Compose the current document from the local mirror (authoritative offline
  // copy), upgraded + validated. Used by export and as a save fallback.
  function _localDoc() {
    try { var s = localStorage.getItem('fm_workspace'); if (s) return migrateWorkspace(JSON.parse(s)).doc; } catch (_) {}
    try {
      return migrateWorkspace({
        tasks: JSON.parse(localStorage.getItem('fm_tasks') || '[]'),
        deliverables: JSON.parse(localStorage.getItem('fm_deliverables') || '[]'),
        kpiScores: JSON.parse(localStorage.getItem('fm_col_kpiScores') || '{}'),
        weeks: JSON.parse(localStorage.getItem('fm_col_weeks') || '[]'),
      }).doc;
    } catch (_) { return migrateWorkspace(null).doc; }
  }

  function client() {
    if (_client) return _client;
    if (window.supabase && HAS_CREDS) _client = window.supabase.createClient(URL, ANON);
    return _client;
  }

  var dataService = {
    backend: BACKEND,
    ready: BACKEND === 'supabase' && HAS_CREDS,
    clientId: CLIENT_ID,

    loadTasks: function () {
      if (BACKEND !== 'supabase') {
        try { var s = localStorage.getItem('fm_tasks'); return Promise.resolve(s ? JSON.parse(s) : []); }
        catch (_) { return Promise.resolve([]); }
      }
      var c = client();
      if (!c) return Promise.resolve([]);
      return c.from('workspace').select('tasks,updated_at').eq('id', 'main').single()
        .then(function (res) {
          if (res.error) { console.warn('[dataService] loadTasks', res.error.message); return []; }
          _lastUpdatedAt = res.data ? res.data.updated_at : null;
          return (res.data && res.data.tasks) || [];
        });
    },

    // Remote save only. The app keeps its own localStorage mirror.
    // Writes directly as the signed-in EDITOR; RLS on `workspace` rejects
    // anyone but that user, so editing rights = being logged in as the editor.
    saveTasks: function (tasks) {
      if (BACKEND !== 'supabase') return Promise.resolve({ ok: true });
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      var at = new Date().toISOString();
      return c.from('workspace')
        .update({ tasks: tasks, updated_at: at, updated_by: CLIENT_ID })
        .eq('id', 'main')
        .then(function (r) {
          if (!r.error) _lastUpdatedAt = at;
          // RLS denial surfaces as an error here (not signed in as editor).
          return { ok: !r.error, error: r.error && r.error.message };
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    subscribe: function (cb) {
      if (BACKEND !== 'supabase') return function () {};
      var c = client();
      if (!c) return function () {};
      var ch = c.channel('workspace-main')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'workspace', filter: 'id=eq.main' },
          function (payload) {
            var row = payload.new || {};
            if (row.updated_by && row.updated_by === CLIENT_ID) return; // ignore our own echo
            _lastUpdatedAt = row.updated_at || _lastUpdatedAt;
            cb(row.tasks || []);
          })
        .subscribe();
      return function () { try { c.removeChannel(ch); } catch (_) {} };
    },

    /* ---- Unified workspace document --------------------------------
       Preferred API. Reads/writes the ENTIRE workspace as one object on
       the 'main' row. New features add a property — no new row, no SQL.
       loadWorkspace() also performs a one-time migration of the legacy
       standalone 'kpiScores' row into the document so existing KPI data
       carries over the first time the doc is loaded. */
    // Resolves { version, metadata, data, migrated }. When `migrated` is true the
    // caller should persist right away so the upgrade is recorded once.
    loadWorkspace: function () {
      if (BACKEND !== 'supabase') {
        return Promise.resolve({ version: SCHEMA_VERSION, metadata: _localDoc().metadata, data: _localDoc().data, migrated: false });
      }
      var c = client();
      // loadFailed:true is load-time only, never persisted — it tells the
      // caller "this is NOT real data, do not apply it or let it drive a
      // save." Distinct from `migrated`, which migrateWorkspace(null) always
      // reports true for (a fresh v1->v2 doc), so before this fix a transient
      // read failure looked identical to "just migrated, persist now" and the
      // app would autosave a blank document over real data on the very next
      // tick. See [[fm-navigate-workspace-wipe-2026-07-01]].
      if (!c) return Promise.resolve(Object.assign(_withFlag(migrateWorkspace(null)), { loadFailed: true }));
      return c.from('workspace').select('tasks,updated_at').eq('id', 'main').single()
        .then(function (res) {
          if (res.error) {
            console.warn('[dataService] loadWorkspace', res.error.message);
            return Object.assign(_withFlag(migrateWorkspace(null)), { loadFailed: true });
          }
          _lastUpdatedAt = res.data ? res.data.updated_at : null;
          var m = migrateWorkspace(res.data && res.data.tasks);
          // One-time legacy import: pull the old standalone kpiScores row into the
          // document, but ONLY while upgrading (so this never runs post-migration).
          if (m.migrated && (!m.doc.data.kpiScores || !Object.keys(m.doc.data.kpiScores).length)) {
            return c.from('workspace').select('tasks').eq('id', 'kpiScores').maybeSingle()
              .then(function (r2) { if (r2.data && r2.data.tasks && Object.keys(r2.data.tasks).length) m.doc.data.kpiScores = r2.data.tasks; return _withFlag(m); })
              .catch(function () { return _withFlag(m); });
          }
          return _withFlag(m);
        });
    },

    // Accepts { version, metadata, data }. Stamps version + updatedAt.
    // Retries transient failures (statement timeout, connection drop) with
    // backoff, since those are exactly the kind of error that often succeeds
    // a moment later — see [[fm-navigate-save-timeout-2026-07-01]].
    // onRetry(attemptNumber), if given, fires right before each retry so the
    // caller can show "Retrying… (attempt N)" instead of a silent re-send.
    saveWorkspace: function (doc, onRetry) {
      var now = new Date().toISOString();
      var out = {
        version: SCHEMA_VERSION,
        metadata: Object.assign({ createdAt: now, appVersion: APP_VERSION }, doc.metadata, { updatedAt: now }),
        data: ensureData(doc.data),
      };
      try { localStorage.setItem('fm_workspace', JSON.stringify(out)); } catch (_) {}
      if (BACKEND !== 'supabase') {
        return Promise.resolve({ ok: true, persisted: false, rowsAffected: 0, reason: 'LOCAL_ONLY', at: now });
      }
      var c = client();
      if (!c) return Promise.resolve({ ok: false, persisted: false, rowsAffected: 0, reason: 'NO_CLIENT', error: 'no client' });

      var RETRY_DELAYS = [1000, 3000]; // ms; one attempt + up to two retries
      var startedAt = Date.now();
      // Short per-call id so retries of the SAME save (and their eventual
      // Postgres-log counterpart, correlated by timestamp) group together in
      // the console instead of reading as unrelated one-off lines.
      var reqId = Date.now().toString(36).slice(-6) + Math.random().toString(36).slice(2, 5);

      function attempt(retryCount) {
        // .select() is REQUIRED for honest success reporting: a bare update
        // returns error:null even when ZERO rows matched (e.g. RLS silently
        // filtered the row because auth.uid() != EDITOR_UID). With .select()
        // PostgREST returns the rows actually written — an empty array means
        // nothing persisted, which we surface as a failure instead of a
        // false-positive ok:true.
        return c.from('workspace')
          .update({ tasks: out, updated_at: now, updated_by: CLIENT_ID })
          .eq('id', 'main')
          .select('id')
          .then(function (r) {
            if (r.error) {
              // Postgres error code 57014 = statement_timeout. Connection-level
              // failures (network drop, pooler reset) carry no .code. Both are
              // transient infra symptoms worth retrying; anything else (bad
              // request, permission denied by grant, etc.) is not.
              var code = r.error.code;
              var transient = code === '57014' || !code;
              if (transient && retryCount < RETRY_DELAYS.length) {
                if (onRetry) onRetry(retryCount + 1);
                console.info('[dataService] saveWorkspace retry', { reqId: reqId, attempt: retryCount + 1, code: code, httpStatus: r.status });
                return delay(RETRY_DELAYS[retryCount]).then(function () { return attempt(retryCount + 1); });
              }
              return {
                ok: false, persisted: false, rowsAffected: 0,
                reason: code === '57014' ? 'TIMEOUT' : 'UPDATE_ERROR',
                error: r.error.message, code: code, httpStatus: r.status, retries: retryCount,
              };
            }
            var rows = r.data || [];
            if (rows.length) {
              _lastUpdatedAt = now;
              return { ok: true, persisted: true, rowsAffected: rows.length, reason: 'OK', at: now, retries: retryCount };
            }
            // Zero rows written. Distinguish the two causes with a follow-up read
            // (read policy is `using(true)`, so an existing row IS visible): if the
            // 'main' row exists, the update was RLS-blocked (uid != EDITOR_UID);
            // if it doesn't exist, the row is missing (needs seeding). Not transient
            // — retrying an RLS block or a missing row changes nothing.
            return c.from('workspace').select('id').eq('id', 'main').maybeSingle()
              .then(function (chk) {
                var exists = !chk.error && chk.data;
                return {
                  ok: false, persisted: false, rowsAffected: 0,
                  reason: exists ? 'RLS_BLOCKED' : 'ROW_NOT_FOUND',
                  error: exists
                    ? 'update blocked by RLS (signed-in uid != editor uid)'
                    : 'main row not found (database not seeded)',
                  retries: retryCount,
                };
              })
              .catch(function () {
                return { ok: false, persisted: false, rowsAffected: 0, reason: 'RLS_BLOCKED_OR_ROW_MISSING', error: 'no rows written', retries: retryCount };
              });
          })
          .catch(function (e) {
            if (retryCount < RETRY_DELAYS.length) {
              if (onRetry) onRetry(retryCount + 1);
              console.info('[dataService] saveWorkspace retry', { reqId: reqId, attempt: retryCount + 1, exception: String(e) });
              return delay(RETRY_DELAYS[retryCount]).then(function () { return attempt(retryCount + 1); });
            }
            return { ok: false, persisted: false, rowsAffected: 0, reason: 'EXCEPTION', error: String(e), retries: retryCount };
          });
      }

      return attempt(0).then(function (r) {
        // Telemetry: reqId ties this line to any '...retry' lines above and to
        // the Supabase Postgres log by timestamp. Console today; swap for a
        // real sink later without touching call sites.
        console.info('[dataService] saveWorkspace', {
          reqId: reqId, ok: r.ok, reason: r.reason, code: r.code, httpStatus: r.httpStatus,
          retries: r.retries || 0, durationMs: Date.now() - startedAt,
        });
        return r;
      });
    },

    subscribeWorkspace: function (cb) {
      if (BACKEND !== 'supabase') return function () {};
      var c = client();
      if (!c) return function () {};
      var ch = c.channel('workspace-main-doc')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'workspace', filter: 'id=eq.main' },
          function (payload) {
            var row = payload.new || {};
            if (row.updated_by && row.updated_by === CLIENT_ID) return; // ignore our own echo
            _lastUpdatedAt = row.updated_at || _lastUpdatedAt;
            cb(_withFlag(migrateWorkspace(row.tasks)));
          })
        .subscribe();
      return function () { try { c.removeChannel(ch); } catch (_) {} };
    },

    /* ---- Backup: export / import the whole workspace ----------------
       Because everything is one document, backup is almost free. Export
       returns a pretty JSON string of the current document; import accepts
       a document of ANY version, upgrades it through the registry, and
       persists it. Returns the applied doc so the UI can refresh state. */
    exportWorkspace: function () {
      return JSON.stringify(_localDoc(), null, 2);
    },

    importWorkspace: function (json) {
      var parsed;
      try { parsed = (typeof json === 'string') ? JSON.parse(json) : json; }
      catch (e) { return Promise.resolve({ ok: false, error: 'Not valid JSON.' }); }
      var m = migrateWorkspace(parsed);
      var data = ensureData(m.doc.data);
      // Run the SAME normalization pipeline as load/realtime so an imported file
      // can't introduce duplicate ids or dangling references. Without this,
      // import was the only data-entry path that skipped repair.
      if (typeof window !== 'undefined' && window.repairData) {
        var fixed = window.repairData(data.tasks, data.deliverables, data.weeks);
        data = Object.assign({}, data, { tasks: fixed.tasks, deliverables: fixed.deliverables, weeks: fixed.weeks });
      }
      var doc = { version: m.doc.version, metadata: m.doc.metadata, data: data };
      return this.saveWorkspace(doc).then(function (r) {
        return { ok: r.ok, error: r.error, doc: { version: doc.version, metadata: doc.metadata, data: data, migrated: m.migrated } };
      });
    },

    /* ---- Generic collections ---------------------------------------
       Every collection is its own `workspace` row keyed by `id`. The
       jsonb payload lives in the same `tasks` column regardless of the
       row id, so it holds whatever shape the collection needs (array
       OR object). The editor RLS UPDATE policy already covers every
       row, so writes need no change — but each new row must be SEEDED
       once via SQL (no INSERT policy). See supabase/schema.sql.
       'main' stays the tasks/deliverables blob (use loadTasks/saveTasks).
       ---------------------------------------------------------------- */
    loadCollection: function (id, fallback) {
      var fb = fallback === undefined ? [] : fallback;
      if (BACKEND !== 'supabase') {
        try { var s = localStorage.getItem('fm_col_' + id); return Promise.resolve(s ? JSON.parse(s) : fb); }
        catch (_) { return Promise.resolve(fb); }
      }
      var c = client();
      if (!c) return Promise.resolve(fb);
      return c.from('workspace').select('tasks,updated_at').eq('id', id).maybeSingle()
        .then(function (res) {
          if (res.error) { console.warn('[dataService] loadCollection ' + id, res.error.message); return fb; }
          if (!res.data) return fb; // row not seeded yet
          return res.data.tasks == null ? fb : res.data.tasks;
        })
        .catch(function () { return fb; });
    },

    saveCollection: function (id, data) {
      try { localStorage.setItem('fm_col_' + id, JSON.stringify(data)); } catch (_) {}
      if (BACKEND !== 'supabase') return Promise.resolve({ ok: true });
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      var at = new Date().toISOString();
      return c.from('workspace')
        .update({ tasks: data, updated_at: at, updated_by: CLIENT_ID })
        .eq('id', id).select('id')
        .then(function (r) {
          if (r.error) return { ok: false, error: r.error.message };
          // 0 rows updated = collection row not seeded (or RLS denied).
          if (!r.data || !r.data.length) return { ok: false, error: 'collection "' + id + '" not seeded — run schema.sql' };
          return { ok: true };
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    subscribeCollection: function (id, cb) {
      if (BACKEND !== 'supabase') return function () {};
      var c = client();
      if (!c) return function () {};
      var ch = c.channel('workspace-' + id)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'workspace', filter: 'id=eq.' + id },
          function (payload) {
            var row = payload.new || {};
            if (row.updated_by && row.updated_by === CLIENT_ID) return; // ignore our own echo
            cb(row.tasks);
          })
        .subscribe();
      return function () { try { c.removeChannel(ch); } catch (_) {} };
    },

    /* ---- Auth + per-user PRIVATE resources (Supabase Auth + RLS) ----
       These power the private vault: rows in `private_resources` are
       readable/writable only by their owner (RLS: auth.uid() = user_id).
       Requires the Supabase setup in docs/PRIVATE-VAULT-SETUP.md. ---- */
    authReady: function () { return BACKEND === 'supabase' && !!client(); },

    signIn: function (email, pw) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'Shared backend not configured.' });
      return c.auth.signInWithPassword({ email: email, password: pw })
        .then(function (r) { return { ok: !r.error, error: r.error && r.error.message, user: r.data && r.data.user }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    signOut: function () {
      var c = client();
      if (!c) return Promise.resolve();
      return c.auth.signOut().catch(function () {});
    },

    getUser: function () {
      var c = client();
      if (!c) return Promise.resolve(null);
      return c.auth.getUser().then(function (r) { return (r && r.data) ? r.data.user : null; }).catch(function () { return null; });
    },

    // subscribe to auth changes; cb(user|null). returns an unsubscribe fn.
    onAuth: function (cb) {
      var c = client();
      if (!c) return function () {};
      var res = c.auth.onAuthStateChange(function (_evt, session) { cb(session ? session.user : null); });
      return function () { try { res.data.subscription.unsubscribe(); } catch (_) {} };
    },

    /* ---- RBAC: profiles, comments, activity (Supabase + RLS) ----
       The role on the profile is the editable copy; the JWT `user_role`
       claim is the runtime source of truth the database enforces. The UI
       reads the profile for name/avatar AND for the role that drives
       permissions.js. See supabase/schema.sql + docs/RBAC-SETUP.md. ---- */

    // The signed-in user's own profile { id, email, name, avatar_url, role, status }.
    // Resolves null when signed out or the row isn't readable yet.
    getMyProfile: function () {
      var c = client();
      if (!c) return Promise.resolve(null);
      return c.auth.getUser().then(function (u) {
        var uid = u && u.data && u.data.user && u.data.user.id;
        if (!uid) return null;
        return c.from('profiles').select('id,email,name,avatar_url,role,status').eq('id', uid).maybeSingle()
          .then(function (r) { return r.error ? null : (r.data || null); });
      }).catch(function () { return null; });
    },

    // The team directory (everyone signed in can read it).
    listProfiles: function () {
      var c = client();
      if (!c) return Promise.resolve([]);
      return c.from('profiles').select('id,email,name,avatar_url,role,status').order('created_at', { ascending: true })
        .then(function (r) { return r.error ? [] : (r.data || []); })
        .catch(function () { return []; });
    },

    // Update a profile's role/status (and name/avatar). The DB enforces who
    // may do this: an owner can change anyone's role/status; the privilege
    // trigger rejects role/status changes from non-owners. Returns the row
    // actually written (empty => RLS/trigger blocked it).
    updateProfile: function (id, patch) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      var allowed = {};
      ['name', 'avatar_url', 'role', 'status'].forEach(function (k) {
        if (patch && patch[k] !== undefined) allowed[k] = patch[k];
      });
      return c.from('profiles').update(allowed).eq('id', id).select()
        .then(function (r) {
          var rows = r.data || [];
          if (r.error) return { ok: false, error: r.error.message };
          if (!rows.length) return { ok: false, error: 'Not permitted (only an owner may change role or status).' };
          return { ok: true, row: rows[0] };
        })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    // List comments on one entity, oldest first.
    listComments: function (entityType, entityId) {
      var c = client();
      if (!c) return Promise.resolve([]);
      return c.from('comments').select('*')
        .eq('entity_type', entityType).eq('entity_id', String(entityId))
        .order('created_at', { ascending: true })
        .then(function (r) { return r.error ? [] : (r.data || []); })
        .catch(function () { return []; });
    },

    // Add a comment as the current user. RLS rejects pure viewers.
    addComment: function (entityType, entityId, body) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      return c.auth.getUser().then(function (u) {
        var uid = u && u.data && u.data.user && u.data.user.id;
        if (!uid) return { ok: false, error: 'Not signed in.' };
        return c.from('comments').insert({
          entity_type: entityType, entity_id: String(entityId), user_id: uid, body: body,
        }).select().then(function (r) { return { ok: !r.error, error: r.error && r.error.message, row: r.data && r.data[0] }; });
      }).catch(function (e) { return { ok: false, error: String(e) }; });
    },

    deleteComment: function (id) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false });
      return c.from('comments').delete().eq('id', id)
        .then(function (r) { return { ok: !r.error, error: r.error && r.error.message }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    // Subscribe to live comment changes for one entity. cb() fires on any change.
    subscribeComments: function (entityType, entityId, cb) {
      var c = client();
      if (!c) return function () {};
      var ch = c.channel('comments-' + entityType + '-' + entityId)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'comments', filter: 'entity_id=eq.' + String(entityId) },
          function () { cb(); })
        .subscribe();
      return function () { try { c.removeChannel(ch); } catch (_) {} };
    },

    // Append one audit-trail entry (best-effort; never blocks the UI).
    logActivity: function (action, entityType, entityId, meta) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false });
      return c.auth.getUser().then(function (u) {
        var uid = u && u.data && u.data.user && u.data.user.id;
        if (!uid) return { ok: false };
        return c.from('activity_log').insert({
          user_id: uid, action: action, entity_type: entityType || null,
          entity_id: entityId != null ? String(entityId) : null, meta: meta || null,
        }).then(function (r) { return { ok: !r.error, error: r.error && r.error.message }; });
      }).catch(function () { return { ok: false }; });
    },

    // Recent audit-trail entries (newest first).
    listActivity: function (limit) {
      var c = client();
      if (!c) return Promise.resolve([]);
      return c.from('activity_log').select('*').order('created_at', { ascending: false }).limit(limit || 100)
        .then(function (r) { return r.error ? [] : (r.data || []); })
        .catch(function () { return []; });
    },

    // list the signed-in user's private resources for one parent
    // (a task or a deliverable). parentType: 'task' | 'deliverable'.
    listResources: function (parentType, parentId) {
      var c = client();
      if (!c) return Promise.resolve([]);
      return c.from('private_resources').select('*')
        .eq('parent_type', parentType).eq('parent_id', parentId)
        .order('created_at', { ascending: true })
        .then(function (r) { return r.error ? [] : (r.data || []); })
        .catch(function () { return []; });
    },

    addResource: function (res) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      return c.auth.getUser().then(function (u) {
        var uid = u && u.data && u.data.user && u.data.user.id;
        if (!uid) return { ok: false, error: 'Not signed in.' };
        return c.from('private_resources').insert({
          user_id: uid, parent_type: res.parentType || 'deliverable', parent_id: res.parentId,
          kind: res.kind || 'link', title: res.title || '', url: res.url || '', note: res.note || '',
        }).select().then(function (r) { return { ok: !r.error, error: r.error && r.error.message, row: r.data && r.data[0] }; });
      }).catch(function (e) { return { ok: false, error: String(e) }; });
    },

    deleteResource: function (id) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false });
      return c.from('private_resources').delete().eq('id', id)
        .then(function (r) { return { ok: !r.error, error: r.error && r.error.message }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    updateResource: function (id, patch) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false });
      var fields = {};
      if (patch.title !== undefined) fields.title = patch.title;
      if (patch.url !== undefined) fields.url = patch.url;
      if (patch.note !== undefined) fields.note = patch.note;
      if (patch.kind !== undefined) fields.kind = patch.kind;
      return c.from('private_resources').update(fields).eq('id', id)
        .then(function (r) { return { ok: !r.error, error: r.error && r.error.message }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    // Purge ALL private resources for one parent (called when a task or
    // deliverable is deleted) so they don't orphan and resurface on a future
    // record. RLS scopes the delete to the caller's own rows; other users'
    // private rows for the same parent can't be reached from here (and are
    // protected from resurfacing by the id high-water mark in data.js).
    deleteResourcesFor: function (parentType, parentId) {
      var c = client();
      if (!c) return Promise.resolve({ ok: true });
      return c.from('private_resources').delete()
        .eq('parent_type', parentType).eq('parent_id', parentId)
        .then(function (r) { return { ok: !r.error, error: r.error && r.error.message }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    // ---- progress-log attachments (Supabase Storage) --------------------
    // Attachments used to live as base64 inline in workspace.tasks, ballooning
    // that single jsonb row to ~11MB and causing statement_timeout (57014) on
    // every save — see [[fm-navigate-save-timeout-2026-07-01]]. Now only a
    // storage `path` is stored on the task record; `file` is a browser
    // File/Blob (or a Blob decoded from a legacy base64 entry during the
    // one-time migration).
    uploadAttachment: function (file, opts) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      var safeName = String((opts && opts.name) || (file && file.name) || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      var idx = (opts && opts.index != null) ? opts.index : 0;
      var path = [opts.taskId, opts.entryId, idx + '-' + safeName].join('/');
      return c.storage.from('task-attachments').upload(path, file, { upsert: true })
        .then(function (r) { return { ok: !r.error, path: path, error: r.error && r.error.message }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },

    // Signed URLs expire (1hr) — always resolve fresh at render time, never
    // persist the URL itself, only the `path`.
    getAttachmentUrl: function (path) {
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      return c.storage.from('task-attachments').createSignedUrl(path, 3600)
        .then(function (r) { return { ok: !r.error, url: r.data && r.data.signedUrl, error: r.error && r.error.message }; })
        .catch(function (e) { return { ok: false, error: String(e) }; });
    },
  };

  window.dataService = dataService;
})();
