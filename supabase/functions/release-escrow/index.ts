import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { createUserClient, getAuthenticatedUser, getBearerToken, isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
type BodyRecord = Record<string, unknown>;

function deviceType(req: Request): "mobile" | "desktop" | "unknown" {
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  if (/android|iphone|ipad|ipod|mobile|windows phone/.test(ua)) return "mobile";
  if (/windows|macintosh|linux x86_64|cros/.test(ua)) return "desktop";
  return "unknown";
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.headers.get("x-health-check") === "true" && req.method === "GET") return new Response("Warm", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) return jsonResponse({ status: "warm", ts: Date.now(), fn: "release-escrow" }, 200, {}, req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);

  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null) return jsonResponse({ error: "Invalid JSON" }, 400, {}, req);
  const record = body as BodyRecord;
  const action = typeof record.action === "string" ? record.action : "";

  if (action === "auto_release") {
    if (!isServiceRoleRequest(req)) return jsonResponse({ error: "Forbidden" }, 403, {}, req);
    const { data: due, error } = await admin.from("transactions").select("id").eq("status", "release_requested").lte("auto_release_at", new Date().toISOString()).limit(100);
    if (error) return jsonResponse({ error: error.message }, 500, {}, req);
    let released = 0;
    for (const tx of due ?? []) {
      const { error: rpcError } = await admin.rpc("process_escrow_action", { p_transaction_id: tx.id, p_action: "auto_release", p_qr_secret: null, p_reason: null });
      if (!rpcError) released++;
      else console.error("auto_release failed", tx.id, rpcError.message);
    }
    return jsonResponse({ success: true, processed: due?.length ?? 0, released }, 200, {}, req);
  }

  const user = await getAuthenticatedUser(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
  try {
    const limit = await enforceRateLimitWithToken(token, "escrow-actions", 30, 60);
    if (!limit.allowed) return jsonResponse({ error: "Rate limit exceeded" }, 429, {}, req);
  } catch {
    return jsonResponse({ error: "Rate limit service unavailable" }, 503, {}, req);
  }

  const transactionId = typeof record.transaction_id === "string" ? record.transaction_id : "";
  if (!transactionId) return jsonResponse({ error: "Missing transaction_id" }, 400, {}, req);
  if (action === "release" && deviceType(req) !== "mobile") return jsonResponse({ error: "Physical QR release must be completed on a phone with GPS. Scan the Transfer-to-Mobile QR to continue.", code: "MOBILE_REQUIRED" }, 403, {}, req);

  if (action === "duress") {
    const code = typeof record.duress_code === "string" ? record.duress_code : null;
    const panicToken = typeof record.panic_token === "string" ? record.panic_token : null;
    if (!code && !panicToken) return jsonResponse({ error: "Missing duress credential" }, 400, {}, req);
    const userClient = createUserClient(token);
    const { data, error } = await userClient.rpc("activate_duress", { p_transaction_id: transactionId, p_code: code, p_panic_token: panicToken });
    if (error) {
      const message = error.message || "Duress activation failed";
      const status = /not authorized|invalid duress|authentication/i.test(message) ? 403 : 400;
      return jsonResponse({ error: message }, status, {}, req);
    }
    return jsonResponse(data, 200, {}, req);
  }

  const rpcArgs = {
    p_transaction_id: transactionId,
    p_action: action,
    p_qr_secret: typeof record.qr_secret === "string" ? record.qr_secret : (typeof record.release_code === "string" ? record.release_code : null),
    p_reason: typeof record.reason === "string" ? record.reason : null,
  };
  let userClient;
  try {
    userClient = createUserClient(token);
  } catch {
    return jsonResponse({ error: "Auth client unavailable" }, 503, {}, req);
  }
  const { data, error } = await userClient.rpc("process_escrow_action", rpcArgs);
  if (error) {
    const message = error.message || "Escrow action failed";
    const status = /not authorized|only the|invalid release credential|frozen by a safety alert|authentication|mobile meetup/i.test(message) ? 403 : 400;
    return jsonResponse({ error: message }, status, {}, req);
  }
  return jsonResponse(data, 200, {}, req);
});
