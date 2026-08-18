/* ============================================================
   FM Navigate — Role-Based Access Control (RBAC)
   ------------------------------------------------------------
   Phase 2 (docs/TDD-ROLES-PERMISSIONS.md): permissions are DATA.
   The whole app still asks `RBAC.can(role, resource, action)`; what
   changed is the backing store behind that one call:

     1. MATRIX MODE (normal): RBAC.load(dataService, uid) fetches the
        `roles` catalog and the caller's grants from `role_permissions`
        once per sign-in (plus realtime refetches), caching per-uid. can()
        answers from that in-memory matrix. Permission toggles made by an owner in
        Settings → Roles & Permissions reach the UI within seconds —
        and the DATABASE enforces them on the very next request.
     2. FALLBACK MODE: if the Phase-2 tables don't exist yet (SQL not
        applied) or the fetch fails, can() answers from DEFAULTS — the
        exact Phase-1 hardcoded matrix. So this client is safe to ship
        before or after the SQL migration, and local mode is unchanged.

   Legacy call sites keep their Phase-1 vocabulary ('workspace'/'write',
   'tasks'/'write', …); ALIASES translates them to the canonical
   catalog keys ('admin.workspace', 'tasks.execute', …) before lookup.

   SECURITY MODEL (unchanged)
   - Authorization SOURCE OF TRUTH is the database: the JWT carries the
     role (`user_role` claim) and RLS policies call authorize(<permission>)
     which looks the role's grants up at query time (supabase/schema.sql).
   - This client layer is a CONVENIENCE: it hides/disables UI the user
     can't use. It is NOT the security boundary — a tampered client
     still hits RLS and is rejected by the database.
   ============================================================ */
(function () {
  'use strict';

  // Static role set = the seeded system roles that existed in Phase 1.
  // In matrix mode these are re-hydrated from the `roles` table, which is
  // how the Phase-2 roles (executive, senior_business_analyst, ba_intern,
  // associate_developer) appear — the hardcoded list is only the fallback.
  var ROLES = [
    'owner',
    'product_manager',
    'investor',
    'business_analyst',
    'tech_lead',
    'developer',
    'qa',
    'member',
    'viewer',
  ];

  var ROLE_LABELS = {
    owner: 'Owner',
    product_manager: 'Product Manager',
    investor: 'Investor',
    business_analyst: 'Business Analyst',
    tech_lead: 'Tech Lead',
    developer: 'Software Engineer',
    qa: 'QA Engineer',
    member: 'Member',
    viewer: 'Viewer',
  };

  /* Legacy call-site vocabulary → canonical catalog key. Applied in BOTH
     modes' lookup key derivation; the fallback additionally understands the
     raw legacy map below. The full audited call-site set (TDD §4):
       workspace.write · tasks.write · tasks.assign · tasks.prioritize ·
       tasks.delete · users.write  (+ read keys used by the nav registry) */
  var ALIASES = {
    // canEdit — GOVERNANCE surfaces (deliverables/weeks/KPI/import/clear).
    // Phase 1 scoped this to owner+PM via workspace.write; admin.workspace
    // is seeded identically. NOT tasks.execute — that would hand every
    // delivery role the governance UI.
    'workspace.write': 'admin.workspace',
    'tasks.write': 'tasks.execute',       // canExecute — work any task
    'users.write': 'users.assign_roles',
    'workspace.read': 'tasks.read',
    // NB: no 'tasks.edit_fields' alias — canEditFields is derived from
    // canEdit/canExecute in app.jsx, nothing calls can('tasks','edit_fields'),
    // so tasks.edit stays Planned (unwired) until a dedicated gate exists.
  };

  /* The Phase-1 matrix, kept verbatim as the FALLBACK (plus read-only
     normalisation: `weekly` read everywhere and the kpi/reports reads that
     Phase 1 omitted for developer/qa — reads were never gated anywhere, so
     this matches actual Phase-1 behaviour and the Phase-2 seeds).
     role → resource → [actions]; '*' = every resource. */
  var DEFAULTS = {
    owner: {
      '*': ['read', 'write', 'create', 'assign', 'prioritize', 'delete', 'approve', 'invite', 'manage'],
    },
    product_manager: {
      workspace: ['read', 'write', 'delete'],
      tasks: ['read', 'write', 'create', 'assign', 'prioritize', 'delete', 'approve'],
      deliverables: ['read', 'write', 'delete'],
      roadmap: ['read', 'write', 'delete'],
      stories: ['read', 'write', 'delete'],
      defects: ['read', 'write'],
      weekly: ['read'],
      kpi: ['read', 'write'],
      reports: ['read', 'write'],
      comments: ['read', 'write', 'delete'],
      settings: ['read'],
    },
    investor: {
      workspace: ['read'],
      tasks: ['read'],
      deliverables: ['read'],
      roadmap: ['read'],
      weekly: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    business_analyst: {
      workspace: ['read'],
      tasks: ['read', 'write', 'create'],
      deliverables: ['read'],
      roadmap: ['read'],
      stories: ['read', 'write', 'delete'],
      weekly: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    tech_lead: {
      workspace: ['read'],
      tasks: ['read', 'write', 'create', 'assign', 'prioritize', 'approve'],
      deliverables: ['read'],
      roadmap: ['read'],
      stories: ['read'],
      defects: ['read', 'write'],
      weekly: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    developer: {
      workspace: ['read'],
      tasks: ['read', 'write', 'create'],
      deliverables: ['read'],
      roadmap: ['read'],
      defects: ['read', 'write'],
      weekly: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    qa: {
      workspace: ['read'],
      tasks: ['read', 'write', 'create'],
      deliverables: ['read'],
      roadmap: ['read'],
      defects: ['read', 'write'],
      weekly: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    // Phase 3 — the self-signup default. A complete PERSONAL task workspace:
    // create and work your own tasks, comment on them. No assign/prioritize/
    // delete, no cross-user visibility (tasks.view_all is matrix-only and false
    // here, so fallback mode is personal-scope), and deliberately none of the
    // organization-wide reads (deliverables/weekly/kpi/reports) so those nav
    // items never appear. Mirrors the personal_execution template exactly.
    member: {
      workspace: ['read'],
      tasks: ['read', 'write', 'create'],
      comments: ['read', 'write'],
    },
    viewer: {
      workspace: ['read'],
      tasks: ['read'],
      deliverables: ['read'],
      roadmap: ['read'],
      weekly: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read'],
    },
  };

  // localStorage cache is SCOPED PER AUTHENTICATED USER. A global key would let
  // account B's failed refetch fall back to account A's cached matrix (A may be
  // an admin who fetched the FULL matrix) — an account-isolation break. Keying
  // by uid means B can only ever read B's own cache; A's cache is invisible to B.
  var LS_PREFIX = 'fm_rbac_matrix:';
  var LEGACY_LS_KEY = 'fm_rbac_matrix'; // pre-isolation global key — purged on load
  function lsKey(uid) { return uid ? LS_PREFIX + uid : null; }

  // role slug → Set(permission keys). null until load() succeeds; while null
  // every can() call answers from DEFAULTS (fallback mode). A user who isn't
  // an admin only receives their OWN role's grants (RLS scopes the read) —
  // other roles' sets stay empty, which is fine: can() is only ever asked
  // about the signed-in role.
  var _matrix = null;
  // The uid the in-memory _matrix belongs to, so a stale matrix from a previous
  // account is never served after an account switch (SPA — no reload between).
  var _matrixUid = null;

  function _applyMatrix(rolesRows, grantRows) {
    var m = {};
    var labels = {};
    var order = [];
    rolesRows.forEach(function (r) {
      m[r.slug] = new Set();
      labels[r.slug] = r.label;
      order.push(r.slug);
    });
    grantRows.forEach(function (g) {
      if (m[g.role_slug]) m[g.role_slug].add(g.permission_key);
    });
    _matrix = m;
    // Hydrate the role catalogue so role pickers show the Phase-2 roles.
    RBAC.ROLES = order;
    RBAC.ROLE_LABELS = labels;
  }

  function _key(resource, action) {
    var k = resource + '.' + action;
    return ALIASES[k] || k;
  }

  // Core check. Matrix mode: canonical-key lookup, deny by default (an
  // unknown key or an empty grant set is simply `false` — Rule 1). Fallback
  // mode: the Phase-1 resource/action logic, wildcard included.
  function can(role, resource, action) {
    if (!role) return false;
    if (_matrix) {
      var set = _matrix[role];
      if (set) return set.has(_key(resource, action));
      // A role the matrix doesn't know (shouldn't happen — roles come from
      // the same table) denies rather than falling back: fail closed.
      return false;
    }
    var map = DEFAULTS[role];
    if (!map) return false;
    var specific = map[resource];
    if (specific && specific.indexOf(action) !== -1) return true;
    var wildcard = map['*'];
    return !!wildcard && wildcard.indexOf(action) !== -1;
  }

  // Wipe in-memory permission state. Call on sign-out and on account change so
  // one account's matrix can never be read by the next (SPA has no reload
  // between accounts). After reset, can() answers from DEFAULTS until reload.
  function reset() {
    _matrix = null;
    _matrixUid = null;
    RBAC.ROLES = ROLES;
    RBAC.ROLE_LABELS = ROLE_LABELS;
  }

  /* Fetch the matrix for the authenticated user `uid`. Resolves true when
     matrix mode is active (fresh fetch or that user's own cache), false when
     staying on DEFAULTS. Never rejects. Safe to call repeatedly — realtime
     refetches route through here too. The cache is per-uid so a failed fetch
     can only ever restore the SAME account's last-known matrix. */
  function load(ds, uid) {
    if (!ds || ds.backend !== 'supabase') return Promise.resolve(false);
    if (typeof ds.listRoles !== 'function') return Promise.resolve(false);
    // A matrix in memory that belongs to a different account must not survive
    // into this load — drop it up front so nothing stale is served mid-fetch.
    if (_matrixUid && _matrixUid !== uid) reset();
    try { localStorage.removeItem(LEGACY_LS_KEY); } catch (_) {} // purge pre-isolation global cache
    var key = lsKey(uid);
    return Promise.all([ds.listRoles(), ds.listRolePermissions()])
      .then(function (res) {
        var roles = res[0], grants = res[1];
        // Empty roles ⇒ tables absent/unreadable (the migration seeds 12) —
        // treat as unavailable. Empty GRANTS with roles present is a valid
        // state (a role stripped of everything) and must stay deny-all.
        if (!roles || !roles.length) throw new Error('rbac tables unavailable');
        _applyMatrix(roles, grants || []);
        _matrixUid = uid;
        if (key) { try { localStorage.setItem(key, JSON.stringify({ roles: roles, grants: grants || [] })); } catch (_) {} }
        return true;
      })
      .catch(function () {
        // Flaky reload: THIS account's last-known matrix beats silently
        // reverting the UI to Phase-1 defaults. Never another account's cache
        // (key is uid-scoped) — the DB enforces the real rules either way.
        try {
          var cached = key ? JSON.parse(localStorage.getItem(key) || 'null') : null;
          if (cached && cached.roles && cached.roles.length) {
            _applyMatrix(cached.roles, cached.grants || []);
            _matrixUid = uid;
            return true;
          }
        } catch (_) {}
        return false;
      });
  }

  var RBAC = {
    ROLES: ROLES,
    ROLE_LABELS: ROLE_LABELS,
    ALIASES: ALIASES,
    DEFAULTS: DEFAULTS,
    can: can,
    load: load,
    reset: reset,
    // true when can() is answering from the live table-driven matrix
    isLive: function () { return !!_matrix; },
    // the uid the in-memory matrix belongs to (null when none) — for tests
    matrixUid: function () { return _matrixUid; },
  };

  window.RBAC = RBAC;
})();
