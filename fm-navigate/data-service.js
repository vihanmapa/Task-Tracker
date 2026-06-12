/* ============================================================
   FM Navigate — data service (localStorage  ←→  Supabase)
   ------------------------------------------------------------
   Single source of truth = ONE "workspace" row holding the whole
   tasks array as jsonb. Reads use the public anon key (RLS lets
   anon SELECT only). Writes go through the password-gated Edge
   Function `tasks-mutate` (holds the service_role key server-side).

   window.dataService:
     backend                 'local' | 'supabase'
     ready                   true when supabase creds present
     loadTasks()             -> Promise<task[]>
     saveTasks(tasks)        -> Promise<{ok, status?, error?}>  (remote only)
     verifyPassword(pw)      -> Promise<boolean>
     setPassword(pw)/getPassword()
     subscribe(cb)           -> unsubscribe fn (realtime; ignores own writes)
   ============================================================ */
(function () {
  var CFG = window.APP_CONFIG || {};
  var BACKEND = CFG.DATA_BACKEND === 'supabase' ? 'supabase' : 'local';
  var URL = CFG.SUPABASE_URL || '';
  var ANON = CFG.SUPABASE_ANON_KEY || '';
  var FN = URL ? URL.replace(/\/$/, '') + '/functions/v1/tasks-mutate' : null;
  var HAS_CREDS = !!(URL && ANON);

  var CLIENT_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
  var _client = null;
  var _pw = null;
  var _lastUpdatedAt = null;

  function client() {
    if (_client) return _client;
    if (window.supabase && HAS_CREDS) _client = window.supabase.createClient(URL, ANON);
    return _client;
  }

  function fnPost(body) {
    return fetch(FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON, 'apikey': ANON },
      body: JSON.stringify(body),
    });
  }

  var dataService = {
    backend: BACKEND,
    ready: BACKEND === 'supabase' && HAS_CREDS,
    clientId: CLIENT_ID,

    setPassword: function (pw) { _pw = pw; try { sessionStorage.setItem('fm_pw', pw); } catch (_) {} },
    getPassword: function () {
      if (_pw) return _pw;
      try { return sessionStorage.getItem('fm_pw'); } catch (_) { return null; }
    },

    verifyPassword: function (pw) {
      if (BACKEND !== 'supabase') return Promise.resolve(true); // local: no real gate
      return fnPost({ action: 'verify', password: pw })
        .then(function (r) { return r.json().then(function (j) { return r.ok && j && j.ok; }); })
        .catch(function () { return false; });
    },

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
    saveTasks: function (tasks) {
      if (BACKEND !== 'supabase') return Promise.resolve({ ok: true });
      var pw = this.getPassword();
      if (!pw) return Promise.resolve({ ok: false, status: 401, error: 'locked' });
      return fnPost({ action: 'save', password: pw, tasks: tasks, clientId: CLIENT_ID })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (j) {
            if (r.ok && j.updated_at) _lastUpdatedAt = j.updated_at;
            return { ok: r.ok, status: r.status, error: j.error };
          });
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

    // list the signed-in user's private resources for a deliverable
    listResources: function (deliverableId) {
      var c = client();
      if (!c) return Promise.resolve([]);
      return c.from('private_resources').select('*').eq('deliverable_id', deliverableId)
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
          user_id: uid, deliverable_id: res.deliverableId,
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
  };

  window.dataService = dataService;
})();
