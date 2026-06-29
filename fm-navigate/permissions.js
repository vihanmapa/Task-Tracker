/* ============================================================
   FM Navigate — Role-Based Access Control (RBAC)
   ------------------------------------------------------------
   ONE config file maps roles → resources → allowed actions.
   The whole app asks `RBAC.can(role, resource, action)` instead
   of checking an email. The implementation behind can() can grow
   (teams, orgs, custom roles, a permissions table) without the UI
   or business logic changing.

   SECURITY MODEL
   - Authorization SOURCE OF TRUTH is the JWT: a custom access-token
     hook stamps the user's role as the `user_role` claim, and RLS
     in Postgres enforces every write (see supabase/schema.sql).
   - This client config is a CONVENIENCE layer: it hides/disables UI
     the user can't use. It is NOT the security boundary — a tampered
     client still hits RLS and is rejected by the database.

   PHASE 1 NOTE
   - Tasks/deliverables/KPIs currently live in ONE jsonb document
     (the `workspace` row). So the only DB-enforced WRITE today is the
     `workspace` resource (owner + product_manager). The richer
     per-resource entries below are intentionally future-named
     (tasks, stories, defects, roadmap, reports, users, settings) so
     that when the blob is normalised into real tables, RLS tightens
     under the SAME can() calls — no UI rewrite.
   ============================================================ */
(function () {
  'use strict';

  // The full role set. Stored as a plain string on the profile and in
  // the JWT claim. Keep in sync with the `app_role` enum in schema.sql.
  var ROLES = [
    'owner',
    'product_manager',
    'investor',
    'business_analyst',
    'tech_lead',
    'developer',
    'qa',
    'viewer',
  ];

  // Human labels for the UI (sidebar, badges, user lists).
  var ROLE_LABELS = {
    owner: 'Owner',
    product_manager: 'Product Manager',
    investor: 'Investor',
    business_analyst: 'Business Analyst',
    tech_lead: 'Tech Lead',
    developer: 'Software Engineer',
    qa: 'QA Engineer',
    viewer: 'Viewer',
  };

  // role → resource → [actions]. '*' as a resource = applies to every
  // resource. Actions: read | write | delete | approve | invite | manage.
  var PERMISSIONS = {
    owner: {
      '*': ['read', 'write', 'delete', 'approve', 'invite', 'manage'],
    },
    product_manager: {
      workspace: ['read', 'write', 'delete'],
      tasks: ['read', 'write', 'delete', 'approve'],
      deliverables: ['read', 'write', 'delete'],
      roadmap: ['read', 'write', 'delete'],
      stories: ['read', 'write', 'delete'],
      defects: ['read', 'write'],
      kpi: ['read', 'write'],
      reports: ['read', 'write'],
      comments: ['read', 'write', 'delete'],
      // NB: no `users` — user administration is an OWNER-only platform concern.
      // A PM who later needs to assign work gets a People picker driven from
      // assignments, NOT this admin directory.
      settings: ['read'],
    },
    investor: {
      workspace: ['read'],
      tasks: ['read'],
      deliverables: ['read'],
      roadmap: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    business_analyst: {
      workspace: ['read'],
      tasks: ['read'],
      deliverables: ['read'],
      roadmap: ['read'],
      stories: ['read', 'write', 'delete'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    tech_lead: {
      workspace: ['read'],
      tasks: ['read', 'write', 'approve'],
      deliverables: ['read'],
      roadmap: ['read'],
      stories: ['read'],
      defects: ['read', 'write'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    developer: {
      workspace: ['read'],
      tasks: ['read', 'write'],
      deliverables: ['read'],
      roadmap: ['read'],
      defects: ['read', 'write'],
      comments: ['read', 'write'],
    },
    qa: {
      workspace: ['read'],
      tasks: ['read'],
      deliverables: ['read'],
      roadmap: ['read'],
      defects: ['read', 'write'],
      reports: ['read'],
      comments: ['read', 'write'],
    },
    viewer: {
      // External stakeholders: read the work, but NOT the team directory or
      // settings (no wildcard, so `users`/`settings` stay hidden from them).
      workspace: ['read'],
      tasks: ['read'],
      deliverables: ['read'],
      roadmap: ['read'],
      kpi: ['read'],
      reports: ['read'],
      comments: ['read'],
    },
  };

  // Core check. Returns true if `role` may perform `action` on `resource`.
  // Looks at the resource-specific grant first, then the '*' wildcard.
  function can(role, resource, action) {
    if (!role) return false;
    var map = PERMISSIONS[role];
    if (!map) return false;
    var specific = map[resource];
    if (specific && specific.indexOf(action) !== -1) return true;
    var wildcard = map['*'];
    return !!wildcard && wildcard.indexOf(action) !== -1;
  }

  window.RBAC = {
    ROLES: ROLES,
    ROLE_LABELS: ROLE_LABELS,
    PERMISSIONS: PERMISSIONS,
    can: can,
  };
})();
