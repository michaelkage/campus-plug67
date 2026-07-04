/**
 * Campus Plug — process-growth-events Edge Function
 *
 * Handles all growth engine events:
 *   - streak_activity    → update daily streak + milestone bonuses
 *   - referral_signup    → register referral relationship
 *   - expire_flash_deals → cron: expire timed-out flash deals
 *   - gig_response       → log response time for avg calculation
 *   - log_view           → record listing view + update viewer count
 *   - checkin            → GPS proximity check + arrived toggle
 *
 * GET /ping → keep-alive handler (responds in <5ms)
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

// Module-level singleton — survives warm invocations
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const ok  = (d: unknown)         => new Response(JSON.stringify(d),             { status: 200, headers: CORS });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s,   headers: CORS });

async function getUser(req: Request) {
  const t = req.headers.get("Authorization")?.replace("Bearer ", "");
  if (!t) return null;
  const { data: { user } } = await admin.auth.getUser(t);
  return user;
}

// Haversine distance in metres (mirrors the SQL function)
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R    = 6_371_000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── Keep-alive ping ────────────────────────────────────────────────────────
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) {
    return ok({ status: "warm", ts: Date.now(), fn: "process-growth-events" });
  }

  if (req.method !== "POST") return bad("Method not allowed", 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return bad("Invalid JSON"); }

  const { action } = body as Record<string, string>;
  const isCron = req.headers.get("Authorization") === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;

  // ── STREAK ACTIVITY ────────────────────────────────────────────────────────
  if (action === "streak_activity") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { data, error } = await admin.rpc("update_streak", { p_user_id: user.id });
    if (error) return bad(error.message, 500);
    return ok({ success: true, ...data });
  }

  // ── REFERRAL SIGNUP ────────────────────────────────────────────────────────
  if (action === "referral_signup") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { referral_code } = body as Record<string, string>;
    if (!referral_code) return bad("Missing referral_code");

    // Find referrer by code
    const { data: referrer } = await admin
      .from("profiles")
      .select("id, full_name")
      .eq("referral_code", referral_code.toUpperCase())
      .neq("id", user.id)
      .maybeSingle();

    if (!referrer) return bad("Invalid referral code", 404);

    // Check not already referred
    const { data: existing } = await admin
      .from("referral_events")
      .select("id")
      .eq("referee_id", user.id)
      .maybeSingle();

    if (existing) return bad("Already referred", 409);

    // Link referred_by in profile
    await admin.from("profiles")
      .update({ referred_by: referrer.id })
      .eq("id", user.id);

    // Create referral event (bonus awarded when they complete first transaction — via DB trigger)
    await admin.from("referral_events").insert({
      referrer_id: referrer.id,
      referee_id:  user.id,
      bonus_awarded: false,
    });

    // Notify referrer
    await admin.from("notifications").insert({
      user_id: referrer.id,
      type:    "referral_joined",
      title:   "🎉 Someone Used Your Referral Code!",
      body:    "They'll need to complete one purchase before you earn your +50 PlugScore bonus.",
      data:    { referee_id: user.id },
    });

    return ok({ success: true, referrer_name: referrer.full_name });
  }

  // ── EXPIRE FLASH DEALS (cron) ──────────────────────────────────────────────
  if (action === "expire_flash_deals") {
    if (!isCron) return bad("Forbidden — cron only", 403);

    const { error } = await admin.rpc("expire_flash_deals");
    if (error) return bad(error.message, 500);
    return ok({ success: true, action: "expired_flash_deals" });
  }

  // ── GIG RESPONSE TIME ──────────────────────────────────────────────────────
  if (action === "gig_response") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { gig_id, response_ms } = body as Record<string, unknown>;
    if (!gig_id || !response_ms) return bad("Missing gig_id or response_ms");

    // Fetch gig to verify seller
    const { data: gig } = await admin
      .from("gigs")
      .select("seller_id, total_response_ms, response_count")
      .eq("id", gig_id)
      .single();

    if (!gig || gig.seller_id !== user.id) return bad("Gig not found or not yours", 404);

    const newTotalMs  = (gig.total_response_ms || 0) + Number(response_ms);
    const newCount    = (gig.response_count   || 0) + 1;
    const newAvgMins  = Math.round(newTotalMs / newCount / 60_000 * 10) / 10;

    await admin.from("gigs").update({
      total_response_ms: newTotalMs,
      response_count:    newCount,
      avg_response_mins: newAvgMins,
    }).eq("id", gig_id);

    return ok({ success: true, avg_response_mins: newAvgMins });
  }

  // ── LOG VIEW ───────────────────────────────────────────────────────────────
  if (action === "log_view") {
    const user = await getUser(req);
    const { listing_id, session_id, duration_s } = body as Record<string, unknown>;
    if (!listing_id || !session_id) return bad("Missing listing_id or session_id");

    // Insert view record
    await admin.from("listing_views").insert({
      listing_id,
      viewer_id:  user?.id ?? null,
      session_id,
      duration_s: Number(duration_s) || null,
    });

    // Increment view_count
    await admin.rpc("increment_view_count", { p_listing_id: listing_id });

    return ok({ success: true });
  }

  // ── CHECK-IN (GPS proximity) ────────────────────────────────────────────────
  if (action === "checkin") {
    const user = await getUser(req);
    if (!user) return bad("Unauthorized", 401);

    const { transaction_id, lat, lng, manual = false } = body as Record<string, unknown>;
    if (!transaction_id) return bad("Missing transaction_id");

    // Fetch transaction
    const { data: tx } = await admin
      .from("transactions")
      .select("id, buyer_id, seller_id, buyer_arrived, seller_arrived, meetup_spot")
      .eq("id", transaction_id)
      .in("status", ["locked", "meetup_initiated"])
      .single();

    if (!tx) return bad("Transaction not found or wrong status", 404);

    const isBuyer  = tx.buyer_id  === user.id;
    const isSeller = tx.seller_id === user.id;
    if (!isBuyer && !isSeller) return bad("Forbidden", 403);

    let proximityOk = Boolean(manual);

    // GPS proximity check against safe zones
    if (!manual && lat && lng) {
      const { data: zones } = await admin
        .from("safe_zones")
        .select("lat, lng, radius_m, name")
        .eq("active", true);

      if (zones) {
        proximityOk = zones.some(z => {
          const dist = haversineM(Number(lat), Number(lng), z.lat, z.lng);
          return dist <= z.radius_m;
        });
      }
    }

    if (!proximityOk) {
      return bad("Not close enough to a Safe Zone. Move within 50m of a designated meetup spot.", 400);
    }

    // Update arrived flag
    const update: Record<string, unknown> = isBuyer
      ? { buyer_arrived: true,  buyer_lat: lat,  buyer_lng: lng,  buyer_arrived_at: new Date().toISOString() }
      : { seller_arrived: true, seller_lat: lat, seller_lng: lng, seller_arrived_at: new Date().toISOString() };

    await admin.from("transactions").update(update).eq("id", transaction_id);

    return ok({
      success:       true,
      arrived_as:    isBuyer ? "buyer" : "seller",
      proximity_ok:  proximityOk,
      other_arrived: isBuyer ? tx.seller_arrived : tx.buyer_arrived,
    });
  }

  return bad(`Unknown action: ${action}`);
});
