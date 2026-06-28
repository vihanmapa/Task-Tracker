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

  // The single account allowed to EDIT the shared workspace (create/move/
  // complete tasks & deliverables). Everyone else is read-only. This is the
  // UI gate; the database also locks writes to this user's id via RLS
  // (see docs/PRIVATE-VAULT-SETUP.md). Match the email of your Supabase user.
  EDITOR_EMAIL: 'vihancmapa@gmail.com',

  // The editor's Supabase auth UID — the SAME value used in the RLS policy
  // (auth.uid() = EDITOR_UID). When set, the UI gates editing on uid instead
  // of email so client and database agree on who can write. Leave '' to fall
  // back to the email check. Find it: Supabase dashboard → Authentication →
  // Users → (your user) → User UID.
  EDITOR_UID: '',
};
