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

  // ---- v2 workspace-document compatibility -------------------------------
  // The newer "weekly workspace" app stores the whole workspace as ONE
  // versioned object — { version, metadata, data:{ tasks, deliverables,
  // weeks, kpiScores } } — in the SAME `tasks` column this (legacy) app
  // reads as a flat [...tasks, ...deliverables] blob. When that object is
  // present we transparently flatten it for reading and, on write, fold our
  // changes back INTO the envelope so we never clobber data this app does
  // not model (weeks, metadata). _envelope holds the last-seen v2 wrapper
  // (null when the row is still a legacy array).
  var _envelope = null;

  function isV2Doc(x) {
    return !!x && typeof x === 'object' && !Array.isArray(x) && !!x.data && typeof x.data === 'object';
  }
  // v2 document -> legacy blob array (deliverables tagged with kind).
  function docToBlob(doc) {
    var d = doc.data || {};
    var tasks = Array.isArray(d.tasks) ? d.tasks : [];
    var dlvs = Array.isArray(d.deliverables) ? d.deliverables : [];
    return tasks.concat(dlvs.map(function (x) {
      var c = {}; for (var k in x) c[k] = x[k]; c.kind = 'deliverable'; return c;
    }));
  }
  // Normalize whatever sits in a `main` row's `tasks` column into the blob
  // array the app expects, remembering the v2 envelope for save-back.
  function normalizeMain(raw) {
    if (isV2Doc(raw)) {
      var data = {}; for (var k in raw.data) data[k] = raw.data[k];
      _envelope = { version: raw.version, metadata: raw.metadata || {}, data: data };
      return docToBlob(raw);
    }
    _envelope = null;
    return Array.isArray(raw) ? raw : [];
  }
  // Build the `tasks` column payload for a write. When a v2 envelope is in
  // play, split the blob back into tasks/deliverables, update the envelope's
  // data in place, and return the whole document; otherwise stay a v1 array.
  function blobToColumn(blob) {
    var arr = Array.isArray(blob) ? blob : [];
    if (!_envelope) return arr;
    var tasks = [], dlvs = [];
    arr.forEach(function (r) {
      if (r && r.kind === 'deliverable') {
        var c = {}; for (var k in r) if (k !== 'kind') c[k] = r[k]; dlvs.push(c);
      } else if (r) { tasks.push(r); }
    });
    _envelope.data.tasks = tasks;
    _envelope.data.deliverables = dlvs;
    var meta = {}; for (var m in _envelope.metadata) meta[m] = _envelope.metadata[m];
    meta.updatedAt = new Date().toISOString();
    _envelope.metadata = meta;
    return { version: _envelope.version, metadata: _envelope.metadata, data: _envelope.data };
  }

  // Legacy per-collection row read (one jsonb payload in its own `tasks` cell).
  function legacyLoadRow(c, id, fb) {
    return c.from('workspace').select('tasks,updated_at').eq('id', id).maybeSingle()
      .then(function (res) {
        if (res.error) { console.warn('[dataService] loadCollection ' + id, res.error.message); return fb; }
        if (!res.data) return fb; // row not seeded yet
        return res.data.tasks == null ? fb : res.data.tasks;
      })
      .catch(function () { return fb; });
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
          return normalizeMain(res.data && res.data.tasks);
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
        .update({ tasks: blobToColumn(tasks), updated_at: at, updated_by: CLIENT_ID })
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
            cb(normalizeMain(row.tasks));
          })
        .subscribe();
      return function () { try { c.removeChannel(ch); } catch (_) {} };
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
      // v2: kpiScores lives inside the main workspace document, not its own
      // row. Source it from there first so the KPI screen isn't stale.
      if (id === 'kpiScores') {
        return c.from('workspace').select('tasks').eq('id', 'main').single()
          .then(function (mres) {
            if (!mres.error && isV2Doc(mres.data && mres.data.tasks)) {
              var kp = mres.data.tasks.data.kpiScores;
              return kp && typeof kp === 'object' ? kp : fb;
            }
            return legacyLoadRow(c, id, fb);
          })
          .catch(function () { return legacyLoadRow(c, id, fb); });
      }
      return legacyLoadRow(c, id, fb);
    },

    saveCollection: function (id, data) {
      try { localStorage.setItem('fm_col_' + id, JSON.stringify(data)); } catch (_) {}
      if (BACKEND !== 'supabase') return Promise.resolve({ ok: true });
      var c = client();
      if (!c) return Promise.resolve({ ok: false, error: 'no client' });
      var at = new Date().toISOString();
      // v2: kpiScores belongs inside the main document. Fold it into the
      // envelope and write the main row instead of a stale per-collection row.
      if (id === 'kpiScores' && _envelope) {
        _envelope.data.kpiScores = data;
        var meta = {}; for (var k in _envelope.metadata) meta[k] = _envelope.metadata[k];
        meta.updatedAt = at; _envelope.metadata = meta;
        return c.from('workspace')
          .update({ tasks: { version: _envelope.version, metadata: _envelope.metadata, data: _envelope.data }, updated_at: at, updated_by: CLIENT_ID })
          .eq('id', 'main').select('id')
          .then(function (r) {
            if (r.error) return { ok: false, error: r.error.message };
            return { ok: true };
          })
          .catch(function (e) { return { ok: false, error: String(e) }; });
      }
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
  };

  window.dataService = dataService;
})();
