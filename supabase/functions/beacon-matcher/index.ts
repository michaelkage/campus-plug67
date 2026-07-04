// Campus Plug — beacon-matcher Edge Function
//
// FIX #12: Broken upsert deduplication.
// The old code did:
//   .upsert({ ..., created_at: new Date().toISOString() }, { onConflict: 'user_id,created_at' })
// Because created_at was freshly generated each call, the composite key was always unique,
// so upsert always INSERTED a new row — deduplication never fired.
//
// Fix: maintain a separate `user_beacons` logical pattern using the existing ticker_events
// table but with a true single-row-per-user upsert keyed on `user_id` alone via an
// explicit DELETE + INSERT pattern, OR by relying on a DB-level unique index.
// Since we can't add a migration here, we use the correct Supabase approach:
//   1. Use INSERT with ON CONFLICT DO UPDATE via a single unique column (`user_id`)
//      for the "current beacon" (event_type = 'beacon_current').
//   2. Separately INSERT a historical log row without any conflict clause.
// This guarantees exactly one "live" beacon row per user while preserving history.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

// Haversine formula — returns distance in metres
function calculateDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): number {
  const R  = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a  =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const ok  = (d: unknown)         => new Response(JSON.stringify(d),             { status: 200, headers: CORS });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s,   headers: CORS });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping"))
    return ok({ status: "warm", ts: Date.now(), fn: "beacon-matcher" });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return bad("Invalid JSON"); }

  const {
    action,
    user_id,
    transaction_id,
    latitude,
    longitude,
    beacon_type  = "meetup",
    max_distance = 500,
  } = body as Record<string, any>;

  if (!action || !user_id || latitude == null || longitude == null) {
    return bad("Missing required fields: action, user_id, latitude, longitude");
  }

  const now = new Date().toISOString();

  // ── UPDATE_BEACON ─────────────────────────────────────────────────────────
  if (action === "update_beacon") {
    // FIX #12: Two separate writes:
    //   A) Upsert the "current beacon" row — keyed on user_id only via event_type='beacon_current'.
    //      This requires a unique index on (user_id, event_type) in the DB.
    //      If that index doesn't exist yet, we fall back to a delete-then-insert pattern.
    //   B) Insert a historical log row normally (no conflict clause).

    // A) Current beacon upsert
    const { error: upsertErr } = await admin
      .from("ticker_events")
      .upsert(
        {
          user_id,
          event_type:     "beacon_current",
          latitude,
          longitude,
          transaction_id: transaction_id ?? null,
          metadata:       { beacon_type, transaction_id },
          created_at:     now,
        },
        { onConflict: "user_id,event_type" }   // unique index on (user_id, event_type)
      );

    if (upsertErr) {
      // Fallback for environments without the unique index: delete + insert
      await admin
        .from("ticker_events")
        .delete()
        .eq("user_id", user_id)
        .eq("event_type", "beacon_current");

      await admin.from("ticker_events").insert({
        user_id,
        event_type:     "beacon_current",
        latitude,
        longitude,
        transaction_id: transaction_id ?? null,
        metadata:       { beacon_type, transaction_id },
        created_at:     now,
      });
    }

    // B) Historical log (always a fresh insert — no deduplication needed)
    await admin.from("ticker_events").insert({
      user_id,
      event_type:     "beacon_update",
      latitude,
      longitude,
      transaction_id: transaction_id ?? null,
      metadata:       { beacon_type, transaction_id },
      created_at:     now,
    });

    // Check for nearby safe zones
    const { data: safeZones, error: zonesErr } = await admin
      .from("safe_zones")
      .select("*")
      .eq("active", true);

    if (zonesErr) return bad("Failed to query safe zones: " + zonesErr.message, 500);

    const nearbySafeZones = (safeZones ?? []).filter((zone) => {
      const dist = calculateDistance(latitude, longitude, zone.latitude, zone.longitude);
      return dist <= zone.radius_meters;
    });

    // Check for nearby transaction partner (if transaction context exists)
    const nearbyBuddies: unknown[] = [];
    if (transaction_id) {
      const { data: tx } = await admin
        .from("transactions")
        .select("buyer_id, seller_id")
        .eq("id", transaction_id)
        .single();

      if (tx) {
        const otherUserId =
          tx.buyer_id === user_id ? tx.seller_id : tx.buyer_id;

        // Get other user's current beacon (the deduplicated row)
        const { data: otherBeacon } = await admin
          .from("ticker_events")
          .select("latitude, longitude, created_at")
          .eq("user_id", otherUserId)
          .eq("event_type", "beacon_current")
          .maybeSingle();

        if (otherBeacon?.latitude != null) {
          const dist = calculateDistance(
            latitude, longitude,
            otherBeacon.latitude, otherBeacon.longitude
          );
          if (dist <= max_distance) {
            nearbyBuddies.push({
              user_id:   otherUserId,
              distance:  Math.round(dist),
              last_seen: otherBeacon.created_at,
            });
          }
        }
      }
    }

    return ok({
      success:          true,
      message:          "Beacon updated successfully",
      nearby_safe_zones: nearbySafeZones,
      nearby_buddies:   nearbyBuddies,
    });
  }

  // ── CHECK_PROXIMITY ───────────────────────────────────────────────────────
  if (action === "check_proximity") {
    if (!transaction_id) {
      return bad("Transaction ID required for proximity check");
    }

    const { data: tx } = await admin
      .from("transactions")
      .select("meetup_latitude, meetup_longitude")
      .eq("id", transaction_id)
      .single();

    if (!tx?.meetup_latitude) {
      return bad("Transaction meetup location not set", 404);
    }

    const distance = calculateDistance(
      latitude, longitude,
      tx.meetup_latitude, tx.meetup_longitude
    );
    const within_range = distance <= max_distance;

    // Log proximity check event
    await admin.from("ticker_events").insert({
      user_id,
      event_type:     "proximity_check",
      transaction_id,
      latitude,
      longitude,
      metadata:       { distance_to_meetup: Math.round(distance), within_range },
      created_at:     now,
    });

    return ok({
      success:      true,
      distance:     Math.round(distance),
      within_range,
      message:      within_range ? "Within meetup range" : "Outside meetup range",
    });
  }

  return bad(`Unknown action: ${action}`);
});
