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
  DATA_BACKEND: 'local',

  // From Supabase dashboard → Project Settings → API
  SUPABASE_URL: '',       // e.g. https://abcdefgh.supabase.co
  SUPABASE_ANON_KEY: '',  // the "anon / public" key (safe to commit)
};
