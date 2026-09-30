/* ============================================================
   FM Navigate — LOCAL config override (example)
   ------------------------------------------------------------
   Copy this file to `config.local.js` (same folder) and fill in
   YOUR Supabase project's values. `config.local.js` is
   gitignored and is loaded only by the dev index.html, right
   after config.js — so it points your local app at your own
   backend without touching the production default in config.js.

   It is never bundled: build.mjs does not read it, so the
   GitHub Pages site always uses config.js.

   Public values only — the anon/publishable key is safe here.
   Never put a service_role key or database password in this file.
   See docs/SECOND-BACKEND-SETUP.md.
   ============================================================ */
Object.assign(window.APP_CONFIG, {
  // Supabase dashboard → Project Settings → API
  SUPABASE_URL: 'https://YOUR_PROJECT_REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR_ANON_OR_PUBLISHABLE_KEY',
});
