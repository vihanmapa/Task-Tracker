// FM Navigate — write proxy for the shared task workspace.
//
// Reads happen client-side with the anon key (RLS allows SELECT only).
// All writes come here so the edit password is checked SERVER-SIDE and
// the service_role key never reaches the browser.
//
// Required secret (set in Supabase dashboard / CLI):
//   EDIT_PASSWORD                  <- the shared password to unlock editing
// Auto-injected by Supabase (do NOT set these yourself):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Deploy:  supabase functions deploy tasks-mutate --no-verify-jwt
// Secret:  supabase secrets set EDIT_PASSWORD='your-passphrase'

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let payload: any;
  try { payload = await req.json(); }
  catch { return json({ error: "invalid json" }, 400); }

  const { action, password, tasks, clientId } = payload || {};

  const EDIT_PASSWORD = Deno.env.get("EDIT_PASSWORD");
  if (!EDIT_PASSWORD) return json({ error: "server not configured (EDIT_PASSWORD missing)" }, 500);

  // Constant-ish password check
  if (typeof password !== "string" || password !== EDIT_PASSWORD) {
    return json({ error: "invalid password" }, 401);
  }

  if (action === "verify") return json({ ok: true });

  if (action === "save") {
    if (!Array.isArray(tasks)) return json({ error: "tasks must be an array" }, 400);
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const updated_at = new Date().toISOString();
    const { error } = await sb
      .from("workspace")
      .upsert({ id: "main", tasks, updated_at, updated_by: clientId ?? null });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, updated_at });
  }

  return json({ error: "unknown action" }, 400);
});
