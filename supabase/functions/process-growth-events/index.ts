/**
 * Campus Plug — process-growth-events Edge Function
 * Handles growth engine events and meetup check-ins.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";

type Body = Record<string, unknown>;
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ok = (req: Request, data: unknown) => jsonResponse(data, 200, {}, req);
const bad = (req: Request, message: string, status = 400) => jsonResponse({ error: message }, status, {}, req);

async function getUser(req: Request) {
  const token = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const { data: { user } } = await admin.auth.getUser(token);
  return user;
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) return ok(req, { status: "warm", ts: Date.now(), fn: "process-growth-events" });
  if (req.method !== "POST") return bad(req, "Method not allowed", 405);

  let body: Body;
  try { body = await req.json(); } catch { return bad(req, "Invalid JSON"); }
  const action = typeof body.action === "string" ? body.action : "";
  const isCron = isServiceRoleRequest(req);

  if (action === "streak_activity") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const { data, error } = await admin.rpc("update_streak", { p_user_id: user.id });
    if (error) return bad(req, error.message, 500);
    return ok(req, { success: true, ...data });
  }

  if (action === "referral_signup") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const referralCode = typeof body.referral_code === "string" ? body.referral_code : "";
    if (!referralCode) return bad(req, "Missing referral_code");
    const { data: referrer } = await admin.from("profiles").select("id, full_name").eq("referral_code", referralCode.toUpperCase()).neq("id", user.id).maybeSingle();
    if (!referrer) return bad(req, "Invalid referral code", 404);
    const { data: existing } = await admin.from("referral_events").select("id").eq("referee_id", user.id).maybeSingle();
    if (existing) return bad(req, "Already referred", 409);
    await admin.from("profiles").update({ referred_by: referrer.id }).eq("id", user.id);
    await admin.from("referral_events").insert({ referrer_id: referrer.id, referee_id: user.id, bonus_awarded: false });
    await admin.from("notifications").insert({ user_id: referrer.id, type: "referral_joined", title: "🎉 Someone Used Your Referral Code!", body: "They'll need to complete one purchase before you earn your +50 PlugScore bonus.", data: { referee_id: user.id } });
    return ok(req, { success: true, referrer_name: referrer.full_name });
  }

  if (action === "expire_flash_deals") {
    if (!isCron) return bad(req, "Forbidden — cron only", 403);
    const { error } = await admin.rpc("expire_flash_deals");
    if (error) return bad(req, error.message, 500);
    return ok(req, { success: true, action: "expired_flash_deals" });
  }

  if (action === "gig_response") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const gigId = typeof body.gig_id === "string" ? body.gig_id : "";
    const responseMs = Number(body.response_ms);
    if (!gigId || !Number.isFinite(responseMs) || responseMs <= 0) return bad(req, "Missing or invalid gig_id or response_ms");
    const { data: gig } = await admin.from("gigs").select("seller_id, total_response_ms, response_count").eq("id", gigId).single();
    if (!gig || gig.seller_id !== user.id) return bad(req, "Gig not found or not yours", 404);
    const newTotalMs = (gig.total_response_ms || 0) + responseMs;
    const newCount = (gig.response_count || 0) + 1;
    const newAvgMins = Math.round(newTotalMs / newCount / 60_000 * 10) / 10;
    await admin.from("gigs").update({ total_response_ms: newTotalMs, response_count: newCount, avg_response_mins: newAvgMins }).eq("id", gigId);
    return ok(req, { success: true, avg_response_mins: newAvgMins });
  }

  if (action === "log_view") {
    const user = await getUser(req);
    const listingId = typeof body.listing_id === "string" ? body.listing_id : "";
    const sessionId = typeof body.session_id === "string" ? body.session_id : "";
    if (!listingId || !sessionId) return bad(req, "Missing listing_id or session_id");
    await admin.from("listing_views").insert({ listing_id: listingId, viewer_id: user?.id ?? null, session_id: sessionId, duration_s: Number(body.duration_s) || null });
    await admin.rpc("increment_view_count", { p_listing_id: listingId });
    return ok(req, { success: true });
  }

  if (action === "checkin") {
    const user = await getUser(req); if (!user) return bad(req, "Unauthorized", 401);
    const transactionId = typeof body.transaction_id === "string" ? body.transaction_id : "";
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const manual = body.manual === true;
    if (!transactionId) return bad(req, "Missing transaction_id");
    const { data: tx } = await admin.from("transactions").select("id, buyer_id, seller_id, buyer_arrived, seller_arrived, meetup_spot").eq("id", transactionId).in("status", ["locked", "meetup_initiated"]).single();
    if (!tx) return bad(req, "Transaction not found or wrong status", 404);
    const isBuyer = tx.buyer_id === user.id;
    const isSeller = tx.seller_id === user.id;
    if (!isBuyer && !isSeller) return bad(req, "Forbidden", 403);
    let proximityOk = manual;
    if (!manual && Number.isFinite(lat) && Number.isFinite(lng)) {
      const { data: zones } = await admin.from("safe_zones").select("lat, lng, radius_m, name").eq("active", true);
      proximityOk = (zones ?? []).some(zone => haversineM(lat, lng, Number(zone.lat), Number(zone.lng)) <= Number(zone.radius_m));
    }
    if (!proximityOk) return bad(req, "Not close enough to a Safe Zone. Move within 50m of a designated meetup spot.", 400);
    const update = isBuyer
      ? { buyer_arrived: true, buyer_lat: lat, buyer_lng: lng, buyer_arrived_at: new Date().toISOString() }
      : { seller_arrived: true, seller_lat: lat, seller_lng: lng, seller_arrived_at: new Date().toISOString() };
    await admin.from("transactions").update(update).eq("id", transactionId);
    return ok(req, { success: true, arrived_as: isBuyer ? "buyer" : "seller", proximity_ok: proximityOk, other_arrived: isBuyer ? tx.seller_arrived : tx.buyer_arrived });
  }

  return bad(req, `Unknown action: ${action}`);
});
