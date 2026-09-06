import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

function isTransientConcurrencyError(message: string) {
  const m = message.toLowerCase();
  return m.includes("deadlock") || m.includes("serialization") || m.includes("statement timeout") || m.includes("could not serialize");
}

async function verifyPaystackPayment(reference: string, expectedAmountKobo: number, poolId: string, userId: string) {
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) return { ok: false as const, reason: "payment_config_missing" };
  const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" } });
  if (!res.ok) return { ok: false as const, reason: "payment_verify_failed" };
  const json: unknown = await res.json().catch(() => null);
  if (typeof json !== "object" || json === null || !("data" in json) || !("status" in json)) return { ok: false as const, reason: "invalid_payment_response" };
  const payload = json as { status?: boolean; data?: { status?: string; amount?: number; metadata?: Record<string, unknown> } };
  const data = payload.data;
  if (!payload.status || data?.status !== "success") return { ok: false as const, reason: "payment_not_successful" };
  if (Number(data.amount) !== Number(expectedAmountKobo)) return { ok: false as const, reason: "payment_amount_mismatch" };
  const meta = data.metadata ?? {};
  if (meta.type && meta.type !== "pool_join") return { ok: false as const, reason: "payment_type_mismatch" };
  if (meta.pool_id && meta.pool_id !== poolId) return { ok: false as const, reason: "payment_pool_mismatch" };
  if (meta.user_id && meta.user_id !== userId) return { ok: false as const, reason: "payment_user_mismatch" };
  return { ok: true as const };
}

async function atomicJoin(poolId: string, userId: string, paystackRef: string | null) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await admin.rpc("atomic_pool_join", { p_pool_id: poolId, p_user_id: userId, p_ref: paystackRef });
    if (!error) return { data, error: null };
    if (!isTransientConcurrencyError(error.message) || attempt === 2) return { data: null, error };
    await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
  }
  return { data: null, error: new Error("Pool join contention") };
}

function stringField(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null || !(key in body)) return null;
  const record = body as Record<string, unknown>;
  return typeof record[key] === "string" ? record[key] : null;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) return jsonResponse({ status: "warm", ts: Date.now(), fn: "join-pool" }, 200, {}, req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  const user = await getAuthenticatedUser(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
  try {
    const limit = await enforceRateLimitWithToken(token, "study-pool-joins", 20, 60);
    if (!limit.allowed) return jsonResponse({ error: "Rate limit exceeded" }, 429, {}, req);
  } catch { return jsonResponse({ error: "Rate limit service unavailable" }, 503, {}, req); }

  const body: unknown = await req.json().catch(() => null);
  const poolId = stringField(body, "pool_id") ?? "";
  const paystackRef = stringField(body, "paystack_ref");
  if (!poolId) return jsonResponse({ error: "Missing pool_id" }, 400, {}, req);

  const { data: poolRow, error: poolErr } = await admin.from("study_pools").select("id,unit_price,payment_refs,status").eq("id", poolId).maybeSingle();
  if (poolErr) return jsonResponse({ error: "Unable to load pool" }, 503, {}, req);
  if (!poolRow) return jsonResponse({ error: "pool_not_found" }, 404, {}, req);
  if (poolRow.status !== "open") return jsonResponse({ error: "pool_closed" }, 400, {}, req);

  const price = Number(poolRow.unit_price ?? 0);
  if (price > 0) {
    if (!paystackRef) return jsonResponse({ error: "Missing paystack_ref" }, 400, {}, req);
    const refs = poolRow.payment_refs ?? [];
    if (Array.isArray(refs) && refs.includes(paystackRef)) return jsonResponse({ error: "payment_already_used" }, 409, {}, req);
    const verified = await verifyPaystackPayment(paystackRef, price, poolId, user.id);
    if (!verified.ok) return jsonResponse({ error: verified.reason }, 402, {}, req);
  }

  const { data, error: resultError } = await atomicJoin(poolId, user.id, paystackRef);
  if (resultError) return jsonResponse({ error: "Pool is busy; please retry" }, 503, {}, req);
  if (!data?.success) {
    const reason = data?.reason;
    const status = reason === "pool_not_found" ? 404 : reason === "pool_full" || reason === "already_joined" || reason === "join_conflict" ? 409 : 400;
    return jsonResponse({ error: reason ?? "Unable to join pool" }, status, {}, req);
  }

  const pool = data.pool;
  const { data: profile } = await admin.from("profiles").select("full_name").eq("id", user.id).single();
  await admin.from("activity_feed").insert({ actor_name: profile?.full_name ?? "A student", actor_id: user.id, action: "joined a study pool", subject: pool.title, amount: pool.unit_price, emoji: "🛒", university: pool.university });
  await admin.from("notifications").insert({ user_id: pool.organizer_id, type: "pool_joined", title: "👋 New Pool Member!", body: `${profile?.full_name ?? "Someone"} joined "${pool.title}". ${pool.max_capacity - pool.current_count} spots remaining.`, data: { pool_id: poolId, current_count: pool.current_count, max_capacity: pool.max_capacity } });
  return jsonResponse({ success: true, current_count: pool.current_count, max_capacity: pool.max_capacity, spots_remaining: Math.max(0, pool.max_capacity - pool.current_count), pool_status: pool.current_count >= pool.max_capacity ? "locked" : "open" }, 200, {}, req);
});
