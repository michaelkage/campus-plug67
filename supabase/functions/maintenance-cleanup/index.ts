import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!service || !isServiceRoleRequest(req)) return jsonResponse({ error: "Forbidden" }, 403, {}, req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) return jsonResponse({ error: "Configuration error" }, 500, {}, req);
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const [{ data: retention, error: e1 }, { data: stale, error: e2 }] = await Promise.all([
    admin.rpc("cleanup_phase2_17_data"),
    admin.rpc("cleanup_stale_idempotency_keys"),
  ]);
  if (e1 || e2) return jsonResponse({ error: e1?.message || e2?.message }, 500, {}, req);
  return jsonResponse({ success: true, retention, stale_idempotency_keys_removed: stale }, 200, {}, req);
});
