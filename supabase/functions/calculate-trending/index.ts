/**
 * Campus Plug — calculate-trending Edge Function v6.3
 *
 * Weighted gravity formula: Score = WeightedViews / (hours_old + 2)^1.5
 * Tier weights: Elite 5× (diminishing returns after 10), Trusted 3×, Citizen 1×
 *
 * Anti-collusion trigger (corrected v6.3 thresholds):
 *   ONLY flags if: views > 50 AND unique viewers < 5 AND negotiations < 2
 *   Escape: ≥10 successful dispute-free trades
 *
 * Rookie boost: 20% of 50 trending slots reserved for verified new users (<30d, <5 sales)
 *
 * Also runs:
 *   - reclaim_silent_jurors (process-dispute cron)
 *   - cleanup_expired_amber (removes stale 90s amber buffers)
 *   - expire_flash_deals
 *
 * GET /ping → keep-alive
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const ok  = (d: unknown)         => new Response(JSON.stringify(d),             { status: 200, headers: CORS });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s,   headers: CORS });

// ── Tier weight with diminishing returns for Elite ────────────────────────────
function tierWeight(tier: string, viewCount: number): number {
  switch (tier) {
    case "elite":
      // 5× base, decrements 0.05 per view over 10, floors at 1.5
      return Math.max(1.5, 5.0 - Math.max(0, viewCount - 10) * 0.05);
    case "trusted": return 3.0;
    default:        return 1.0;
  }
}

// ── Gravity score ─────────────────────────────────────────────────────────────
function gravity(weightedViews: number, msgs1h: number, hoursOld: number): number {
  const numerator = weightedViews + msgs1h * 5.0;
  const decay     = Math.pow(Math.max(hoursOld + 2, 0.1), 1.5);
  return Math.round((numerator / decay) * 1000) / 1000;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping"))
    return ok({ status: "warm", ts: Date.now(), fn: "calculate-trending" });

  const isCron = req.headers.get("Authorization") === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
  if (!isCron) return bad("Forbidden — cron only", 403);
  if (req.method !== "POST") return bad("Method not allowed", 405);

  const now = new Date();

  try {
    // ── Fetch active listings with seller metadata ─────────────────────────
    const { data: candidates } = await admin.from("listings")
      .select("id, created_at, university, seller_id, profiles(tier, collusion_flag, total_sales, created_at, gps_spoof_flags)")
      .eq("status", "active")
      .limit(500);

    if (!candidates?.length) return ok({ processed: 0 });

    const listingIds = candidates.map(c => c.id);

    // ── Views: last 1h and last 24h ───────────────────────────────────────
    const [views1hRes, totalViewsRes, msgs1hRes] = await Promise.all([
      admin.from("listing_views")
        .select("listing_id, viewer_id")
        .in("listing_id", listingIds)
        .gte("viewed_at", new Date(Date.now() - 3_600_000).toISOString()),

      admin.from("listing_views")
        .select("listing_id, viewer_id")
        .in("listing_id", listingIds)
        .gte("viewed_at", new Date(Date.now() - 86_400_000).toISOString()),

      admin.from("messages")
        .select("listing_id, sender_id")
        .in("listing_id", listingIds)
        .gte("created_at", new Date(Date.now() - 3_600_000).toISOString())
        .eq("is_system_msg", false),
    ]);

    // Build lookup maps: listing_id → Set<viewer/sender>
    const mkMap = (rows: any[], idKey: string, valKey: string) => {
      const m = new Map<string, Set<string>>();
      for (const r of rows || []) {
        if (!m.has(r[idKey])) m.set(r[idKey], new Set());
        if (r[valKey]) m.get(r[idKey])!.add(r[valKey]);
      }
      return m;
    };

    const views1hMap   = mkMap(views1hRes.data  || [], "listing_id", "viewer_id");
    const totalViewMap = mkMap(totalViewsRes.data || [], "listing_id", "viewer_id");
    const msgs1hMap    = mkMap(msgs1hRes.data    || [], "listing_id", "sender_id");

    // ── Anti-collusion: CORRECTED thresholds (v6.3) ────────────────────────
    // Trigger ONLY if: total_1h_views > 50 AND unique_viewers < 5 AND negotiations < 2
    // This prevents false positives on legitimately popular listings.
    const sellerViewMap = new Map<string, { totalViews: number; uniqueViewers: Set<string>; negotiations: number }>();

    for (const c of candidates) {
      if (!sellerViewMap.has(c.seller_id)) {
        sellerViewMap.set(c.seller_id, { totalViews: 0, uniqueViewers: new Set(), negotiations: 0 });
      }
      const s = sellerViewMap.get(c.seller_id)!;

      // Sum across all seller's listings
      const v1h  = views1hMap.get(c.id);
      const msgs = msgs1hMap.get(c.id);
      if (v1h)  { s.totalViews += v1h.size; v1h.forEach(vid => s.uniqueViewers.add(vid)); }
      if (msgs) { s.negotiations += msgs.size; }
    }

    const collusionFlaggedSellers = new Set<string>();

    for (const [sellerId, data] of sellerViewMap.entries()) {
      const { totalViews, uniqueViewers, negotiations } = data;

      // Corrected trigger conditions:
      const triggerCollusion = totalViews > 50
                            && uniqueViewers.size < 5
                            && negotiations < 2;

      if (!triggerCollusion) continue;

      // Escape condition: seller with ≥10 successful trades is immune
      const seller = candidates.find(c => c.seller_id === sellerId)?.profiles as any;
      if ((seller?.total_sales || 0) >= 10) continue;
      if (seller?.collusion_flag) continue;  // Already flagged

      collusionFlaggedSellers.add(sellerId);
      await admin.from("profiles").update({
        collusion_flag:       true,
        collusion_ceiling:    60,
        collusion_flagged_at: now.toISOString(),
      }).eq("id", sellerId);
    }

    // ── Score calculation ──────────────────────────────────────────────────
    type Scored = {
      listing_id: string; score: number;
      views_1h: number; views_24h: number; messages_1h: number;
      eligible: boolean; is_rookie: boolean;
    };

    const scores: Scored[] = [];

    for (const c of candidates) {
      const profile      = c.profiles as any;
      const uniq1h       = views1hMap.get(c.id)?.size  || 0;
      const uniqTotal    = totalViewMap.get(c.id)?.size || 0;
      const uniqMsgs1h   = msgs1hMap.get(c.id)?.size   || 0;
      const hoursOld     = (now.getTime() - new Date(c.created_at).getTime()) / 3_600_000;

      // Eligibility: ≥15 unique total views AND ≥2 unique negotiations
      const eligible = uniqTotal >= 15 && uniqMsgs1h >= 2;

      // Collusion ceiling
      const isCollusion = collusionFlaggedSellers.has(c.seller_id) || profile?.collusion_flag;
      const ceiling     = isCollusion ? 60 : 100;

      const tier   = profile?.tier || "citizen";
      const wViews = Math.min(uniq1h * tierWeight(tier, uniq1h), ceiling);
      const score  = eligible ? gravity(wViews, uniq1h, hoursOld) : 0;

      // Rookie: joined <30 days, <5 sales, no collusion
      const joinedDaysAgo = (now.getTime() - new Date(profile?.created_at || now).getTime()) / 86_400_000;
      const isRookie = !isCollusion
        && joinedDaysAgo < 30
        && (profile?.total_sales || 0) < 5;

      scores.push({ listing_id: c.id, score, views_1h: uniq1h, views_24h: uniqTotal, messages_1h: uniqMsgs1h, eligible, is_rookie: isRookie });
    }

    // Sort descending
    scores.sort((a, b) => b.score - a.score);

    // ── Rookie boost: 20% of 50 slots ─────────────────────────────────────
    const TOTAL_SLOTS  = 50;
    const ROOKIE_SLOTS = Math.floor(TOTAL_SLOTS * 0.2); // 10
    const REG_SLOTS    = TOTAL_SLOTS - ROOKIE_SLOTS;    // 40

    const rookieSet   = new Set(scores.filter(s => s.eligible && s.is_rookie).map(s => s.listing_id));
    const regTop      = scores.filter(s => s.eligible && !rookieSet.has(s.listing_id)).slice(0, REG_SLOTS);
    const rookieTop   = scores.filter(s => s.eligible && rookieSet.has(s.listing_id)).slice(0, ROOKIE_SLOTS);
    const trending    = [...regTop, ...rookieTop];
    const trendingIds = new Set(trending.map(t => t.listing_id));

    // ── Upsert trending table ──────────────────────────────────────────────
    if (trending.length > 0) {
      await admin.from("trending_listings").upsert(
        trending.map(t => ({
          listing_id:  t.listing_id,
          views_1h:    t.views_1h,
          views_24h:   t.views_24h,
          messages_1h: t.messages_1h,
          score:       t.score,
          updated_at:  now.toISOString(),
        })),
        { onConflict: "listing_id" }
      );
    }

    // ── Mark/unmark is_trending ────────────────────────────────────────────
    if (trendingIds.size > 0) {
      await admin.from("listings").update({ is_trending: true })
        .in("id", [...trendingIds]);
    }

    const staleIds = scores
      .filter(s => !trendingIds.has(s.listing_id))
      .map(s => s.listing_id);

    if (staleIds.length > 0) {
      await admin.from("listings").update({ is_trending: false })
        .in("id", staleIds).eq("is_trending", true);
      await admin.from("trending_listings").delete().in("listing_id", staleIds);
    }

    // ── Housekeeping ───────────────────────────────────────────────────────
    // Expire flash deals
    await admin.rpc("expire_flash_deals");

    // Clean expired amber confirmations
    await admin.rpc("cleanup_expired_amber");

    // Trigger juror reclaim (silent jurors get replaced)
    await admin.rpc("reclaim_silent_jurors");

    // Reset daily juror counts at midnight
    if (now.getHours() === 0 && now.getMinutes() < 16) {
      await admin.from("profiles").update({ juror_cases_today: 0 })
        .neq("juror_cases_today", 0);
    }

    return ok({
      trending:            trending.length,
      rookie_slots:        rookieTop.length,
      regular_slots:       regTop.length,
      processed:           candidates.length,
      collusion_flagged:   collusionFlaggedSellers.size,
      ts:                  now.toISOString(),
    });

  } catch (err) {
    console.error("[calculate-trending v6.3]", err);
    return bad("Internal error: " + (err as Error).message, 500);
  }
});
