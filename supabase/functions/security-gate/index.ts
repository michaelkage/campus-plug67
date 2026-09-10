import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

function getPrivilegedKey(): string | null {
  // Supabase's current Edge Runtime provides the secret API keys as a JSON map.
  // Prefer that source over the deprecated legacy service_role variable so a
  // rotated/deactivated legacy key cannot break the security gate.
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, unknown>;
      const defaultKey = keys.default;
      if (typeof defaultKey === "string" && defaultKey.trim()) return defaultKey.trim();
    } catch {
      // Fall through to the legacy compatibility path below.
    }
  }

  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  return legacy || null;
}

const privilegedKey = getPrivilegedKey();
const admin = privilegedKey
  ? createClient(Deno.env.get("SUPABASE_URL")!, privilegedKey, { auth: { persistSession: false } })
  : null;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requestIp(req: Request) {
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);

  const body: unknown = await req.json().catch(() => null);
  if (typeof body !== "object" || body === null) return jsonResponse({ error: "Invalid JSON" }, 400, {}, req);
  const record = body as Record<string, unknown>;
  const action = String(record.action ?? "check");
  if (action !== "check" && action !== "register") return jsonResponse({ error: "Invalid action" }, 400, {}, req);

  const token = getBearerToken(req);
  if (token) {
    try {
      const limit = await enforceRateLimitWithToken(token, "security-gate", 20, 60);
      if (!limit.allowed) return jsonResponse({ error: "Rate limit exceeded" }, 429, {}, req);
    } catch { return jsonResponse({ error: "Rate limit service unavailable" }, 503, {}, req); }
  }

  const user = await getAuthenticatedUser(req);
  if (action === "register" && !user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  // Server-observed signals are never accepted from the browser body.
  const ip = requestIp(req);
  const ua = (req.headers.get("user-agent") || "unknown").slice(0, 512);
  const language = (req.headers.get("accept-language") || "").slice(0, 128);
  const serverFingerprint = await sha256(`${ip}\n${ua}\n${language}`);
  const clientFingerprint = typeof record.client_fingerprint === "string" ? record.client_fingerprint.slice(0, 128) : null;

  if (!admin) return jsonResponse({ error: "Security service unavailable" }, 503, {}, req);

  const { data: banHit, error: banError } = await admin.rpc("check_device_ban", {
    p_server_fingerprint: serverFingerprint,
    p_ip: ip === "unknown" ? null : ip,
    p_client_fingerprint: clientFingerprint,
  });

  if (banError) {
    const { data: banned, error: bannedError } = await admin.from("banned_devices")
      .select("ban_reason,reason")
      .eq("server_fingerprint", serverFingerprint)
      .eq("active", true)
      .maybeSingle();
    if (bannedError) return jsonResponse({ error: "Security service unavailable" }, 503, {}, req);
    if (banned) return jsonResponse({ error: `DEVICE_BANNED: ${banned.ban_reason || banned.reason || "This device has been restricted."}` }, 403, {}, req);
  } else if (banHit?.banned) {
    return jsonResponse({ error: `DEVICE_BANNED: ${banHit.reason || "This device has been restricted."}` }, 403, {}, req);
  }

  if (user) {
    const deviceHash = clientFingerprint || serverFingerprint;
    const { error } = await admin.from("user_security").upsert({
      user_id: user.id,
      device_hash: deviceHash,
      server_fingerprint: serverFingerprint,
      ip_address: ip,
      user_agent: ua,
      trusted: false,
      risk_score: 0,
      last_seen_at: new Date().toISOString(),
      last_risk_check_at: new Date().toISOString(),
    }, { onConflict: "user_id,device_hash" });
    if (error) return jsonResponse({ error: "Unable to register security context" }, 503, {}, req);
  }

  return jsonResponse({ success: true }, 200, {}, req);
});
