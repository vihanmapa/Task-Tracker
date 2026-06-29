/* ============================================================
   FM Navigate — runtime config (PUBLIC values only)
   ------------------------------------------------------------
   The Supabase anon key is designed to be public — it is safe
   to commit. Write access is protected by Row Level Security +
   the password-gated Edge Function, NOT by hiding this key.
   Never put the service_role key or the edit password here.
   ============================================================ */
window.APP_CONFIG = {
  // 'local'    → tasks live in this browser only (localStorage)
  // 'supabase' → tasks shared across everyone via Supabase
  DATA_BACKEND: 'supabase',

  // From Supabase dashboard → Project Settings → API
  SUPABASE_URL: 'https://qxrozpuupaddohzwulun.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF4cm96cHV1cGFkZG9oend1bHVuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwODM1ODYsImV4cCI6MjA5NjY1OTU4Nn0.yLBc02LgNw5X3pBDkLyNcsMpTx65pwzjssPCsnHu_cg',

  // Edit rights are NO LONGER a single editor email. Authorization is now
  // role-based (RBAC): each user has a role on their profile, that role is
  // stamped into the JWT, and Row Level Security enforces writes server-side.
  // The role→permission map the UI reads lives in permissions.js; the database
  // policies live in supabase/schema.sql. Assign roles in Supabase (or the
  // future Users screen) — there is nothing to configure here. See
  // docs/RBAC-SETUP.md.
};
