/**
 * Campus Plug — calculate-trending Edge Function v6.4
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { jsonResponse, optionsResponse, isServiceRoleRequest } from "../_shared/auth.ts";

type ProfileMeta = { tier?: string; collusion_flag?: boolean; total_sales?: number; created_at?: string; gps_spoof_flags?: number };
type Candidate = { id: string; created_at: string; university: string | null; seller_id: string; profiles: ProfileMeta | null };
type ActivityRow = { listing_id: string; viewer_id?: string | null; sender_id?: string | null };
type Scored = { listing_id: string; score: number; views_1h: number; views_24h: number; messages_1h: number; eligible: boolean; is_rookie: boolean };

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const ok = (req: Request, data: unknown) => jsonResponse(data, 200, {}, req);
const bad = (req: Request, message: string, status = 400) => jsonResponse({ error: message }, status, {}, req);

function tierWeight(tier: string, viewCount: number): number {
  switch (tier) {
    case "elite": return Math.max(1.5, 5.0 - Math.max(0, viewCount - 10) * 0.05);
    case "trusted": return 3.0;
    default: return 1.0;
  }
}

function gravity(weightedViews: number, msgs1h: number, hoursOld: number): number {
  const numerator = weightedViews + msgs1h * 5.0;
  const decay = Math.pow(Math.max(hoursOld + 2, 0.1), 1.5);
  return Math.round((numerator / decay) * 1000) / 1000;
}

function rowsToMap(rows: ActivityRow[], valueKey: "viewer_id" | "sender_id"): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!map.has(row.listing_id)) map.set(row.listing_id, new Set());
    const value = row[valueKey];
    if (value) map.get(row.listing_id)!.add(value);
  }
  return map;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) return ok(req, { status: "warm", ts: Date.now(), fn: "calculate-trending" });
  if (!isServiceRoleRequest(req)) return bad(req, "Forbidden — cron only", 403);
  if (req.method !== "POST") return bad(req, "Method not allowed", 405);

  const now = new Date();
  try {
    const { data: rawCandidates, error: candidateError } = await admin.from("listings")
      .select("id, created_at, university, seller_id, profiles(tier, collusion_flag, total_sales, created_at, gps_spoof_flags)")
      .eq("status", "active").limit(500);
    if (candidateError) return bad(req, candidateError.message, 500);

    const candidates = (rawCandidates ?? []) as Candidate[];
    if (!candidates.length) return ok(req, { processed: 0 });
    const listingIds = candidates.map(c => c.id);

    const [views1hRes, totalViewsRes, msgs1hRes] = await Promise.all([
      admin.from("listing_views").select("listing_id, viewer_id").in("listing_id", listingIds).gte("viewed_at", new Date(Date.now() - 3_600_000).toISOString()),
      admin.from("listing_views").select("listing_id, viewer_id").in("listing_id", listingIds).gte("viewed_at", new Date(Date.now() - 86_400_000).toISOString()),
      admin.from("messages").select("listing_id, sender_id").in("listing_id", listingIds).gte("created_at", new Date(Date.now() - 3_600_000).toISOString()).eq("is_system_msg", false),
    ]);
    if (views1hRes.error) return bad(req, views1hRes.error.message, 500);
    if (totalViewsRes.error) return bad(req, totalViewsRes.error.message, 500);
    if (msgs1hRes.error) return bad(req, msgs1hRes.error.message, 500);

    const views1hMap = rowsToMap((views1hRes.data ?? []) as ActivityRow[], "viewer_id");
    const totalViewMap = rowsToMap((totalViewsRes.data ?? []) as ActivityRow[], "viewer_id");
    const msgs1hMap = rowsToMap((msgs1hRes.data ?? []) as ActivityRow[], "sender_id");

    const sellerViewMap = new Map<string, { totalViews: number; uniqueViewers: Set<string>; negotiations: number }>();
    for (const candidate of candidates) {
      if (!sellerViewMap.has(candidate.seller_id)) sellerViewMap.set(candidate.seller_id, { totalViews: 0, uniqueViewers: new Set(), negotiations: 0 });
      const seller = sellerViewMap.get(candidate.seller_id)!;
      const views = views1hMap.get(candidate.id);
      const messages = msgs1hMap.get(candidate.id);
      if (views) { seller.totalViews += views.size; views.forEach(id => seller.uniqueViewers.add(id)); }
      if (messages) seller.negotiations += messages.size;
    }

    const collusionFlaggedSellers = new Set<string>();
    for (const [sellerId, data] of sellerViewMap.entries()) {
      const triggerCollusion = data.totalViews > 50 && data.uniqueViewers.size < 5 && data.negotiations < 2;
      if (!triggerCollusion) continue;
      const seller = candidates.find(c => c.seller_id === sellerId)?.profiles;
      if ((seller?.total_sales ?? 0) >= 10 || seller?.collusion_flag) continue;
      collusionFlaggedSellers.add(sellerId);
      const { error } = await admin.from("profiles").update({ collusion_flag: true, collusion_ceiling: 60, collusion_flagged_at: now.toISOString() }).eq("id", sellerId);
      if (error) return bad(req, error.message, 500);
    }

    const scores: Scored[] = [];
    for (const candidate of candidates) {
      const profile = candidate.profiles;
      const uniq1h = views1hMap.get(candidate.id)?.size ?? 0;
      const uniqTotal = totalViewMap.get(candidate.id)?.size ?? 0;
      const uniqMsgs1h = msgs1hMap.get(candidate.id)?.size ?? 0;
      const hoursOld = (now.getTime() - new Date(candidate.created_at).getTime()) / 3_600_000;
      const eligible = uniqTotal >= 15 && uniqMsgs1h >= 2;
      const isCollusion = collusionFlaggedSellers.has(candidate.seller_id) || Boolean(profile?.collusion_flag);
      const ceiling = isCollusion ? 60 : 100;
      const tier = profile?.tier || "citizen";
      const wViews = Math.min(uniq1h * tierWeight(tier, uniq1h), ceiling);
      const score = eligible ? gravity(wViews, uniq1h, hoursOld) : 0;
      const joinedDaysAgo = (now.getTime() - new Date(profile?.created_at || now).getTime()) / 86_400_000;
      const isRookie = !isCollusion && joinedDaysAgo < 30 && (profile?.total_sales ?? 0) < 5;
      scores.push({ listing_id: candidate.id, score, views_1h: uniq1h, views_24h: uniqTotal, messages_1h: uniqMsgs1h, eligible, is_rookie: isRookie });
    }

    scores.sort((a, b) => b.score - a.score);
    const TOTAL_SLOTS = 50;
    const ROOKIE_SLOTS = Math.floor(TOTAL_SLOTS * 0.2);
    const REG_SLOTS = TOTAL_SLOTS - ROOKIE_SLOTS;
    const rookieSet = new Set(scores.filter(s => s.eligible && s.is_rookie).map(s => s.listing_id));
    const regTop = scores.filter(s => s.eligible && !rookieSet.has(s.listing_id)).slice(0, REG_SLOTS);
    const rookieTop = scores.filter(s => s.eligible && rookieSet.has(s.listing_id)).slice(0, ROOKIE_SLOTS);
    const trending = [...regTop, ...rookieTop];
    const trendingIds = new Set(trending.map(t => t.listing_id));

    if (trending.length > 0) {
      const { error } = await admin.from("trending_listings").upsert(trending.map(t => ({ listing_id: t.listing_id, views_1h: t.views_1h, views_24h: t.views_24h, messages_1h: t.messages_1h, score: t.score, updated_at: now.toISOString() })), { onConflict: "listing_id" });
      if (error) return bad(req, error.message, 500);
    }
    if (trendingIds.size > 0) {
      const { error } = await admin.from("listings").update({ is_trending: true }).in("id", [...trendingIds]);
      if (error) return bad(req, error.message, 500);
    }

    const staleIds = scores.filter(s => !trendingIds.has(s.listing_id)).map(s => s.listing_id);
    if (staleIds.length > 0) {
      const { error: listingError } = await admin.from("listings").update({ is_trending: false }).in("id", staleIds).eq("is_trending", true);
      if (listingError) return bad(req, listingError.message, 500);
      const { error: trendingError } = await admin.from("trending_listings").delete().in("listing_id", staleIds);
      if (trendingError) return bad(req, trendingError.message, 500);
    }

    // Trending owns ranking. Escrow/dispute maintenance is handled by their
    // dedicated workers; do not invoke parameterised jury RPCs from here.
    const { error: flashError } = await admin.rpc("expire_flash_deals");
    if (flashError) return bad(req, flashError.message, 500);
    if (now.getHours() === 0 && now.getMinutes() < 16) {
      const { error } = await admin.from("profiles").update({ juror_cases_today: 0 }).neq("juror_cases_today", 0);
      if (error) return bad(req, error.message, 500);
    }

    return ok(req, { trending: trending.length, rookie_slots: rookieTop.length, regular_slots: regTop.length, processed: candidates.length, collusion_flagged: collusionFlaggedSellers.size, ts: now.toISOString() });
  } catch (err) {
    console.error("[calculate-trending v6.4]", err);
    return bad(req, "Internal error: " + (err instanceof Error ? err.message : "Unknown error"), 500);
  }
});
