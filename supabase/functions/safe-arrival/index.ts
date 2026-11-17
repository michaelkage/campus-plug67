import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function deviceType(req: Request): "mobile" | "desktop" | "unknown" {
  const ua = (req.headers.get("user-agent") || "").toLowerCase();
  if (/android|iphone|ipad|ipod|mobile|windows phone/.test(ua)) return "mobile";
  if (/windows|macintosh|linux x86_64|cros/.test(ua)) return "desktop";
  return "unknown";
}

function isValidCoordinate(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);

  const user = await getAuthenticatedUser(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  const type = deviceType(req);
  if (type !== "mobile") {
    return jsonResponse(
      {
        error: "Meetup verification is mobile-only. Scan the transfer-to-mobile QR code to continue.",
        code: "MOBILE_REQUIRED",
      },
      403,
      {},
      req,
    );
  }

  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return jsonResponse({ error: "Invalid JSON" }, 400, {}, req);

  const transactionId = typeof body.transaction_id === "string" ? body.transaction_id.trim() : "";
  const role = body.role === "buyer" || body.role === "seller" ? body.role : "";
  const lat = body.lat;
  const lng = body.lng;

  if (!transactionId || !role || !isValidCoordinate(lat, -90, 90) || !isValidCoordinate(lng, -180, 180)) {
    return jsonResponse({ error: "Invalid arrival fields" }, 400, {}, req);
  }

  const { data, error } = await admin.rpc("record_safe_arrival_v2", {
    p_transaction_id: transactionId,
    p_role: role,
    p_lat: lat,
    p_lng: lng,
    p_user_id: user.id,
    p_device_type: type,
  });

  if (error) return jsonResponse({ error: "Unable to record safe arrival" }, 400, {}, req);
  return jsonResponse(data, 200, {}, req);
});
