/**
 * Campus Plug — join-pool Edge Function
 * Called by Paystack webhook when a pool participant pays.
 * Also handles the pool-join action directly (optimistic, pre-payment).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

const ok  = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: CORS });
const bad = (m: string, s = 400) => new Response(JSON.stringify({ error: m }), { status: s, headers: CORS });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping"))
    return ok({ status: "warm", ts: Date.now() });

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return bad("Unauthorized", 401);

  let body: Record<string, string>;
  try { body = await req.json(); }
  catch { return bad("Invalid JSON"); }

  const { pool_id, paystack_ref } = body;
  if (!pool_id) return bad("Missing pool_id");

  // Fetch pool with lock for update
  const { data: pool, error: poolErr } = await admin
    .from("study_pools")
    .select("*")
    .eq("id", pool_id)
    .single();

  if (poolErr || !pool) return bad("Pool not found", 404);
  if (pool.status !== "open") return bad("Pool is no longer accepting participants");
  if (pool.current_count >= pool.max_capacity) return bad("Pool is full");
  if (pool.participants.includes(user.id)) return bad("You're already in this pool");
  if (new Date(pool.expires_at) < new Date()) return bad("Pool has expired");

  // Add user to pool
  const newParticipants = [...pool.participants, user.id];
  const newCount = pool.current_count + 1;
  const newRefs = paystack_ref ? [...pool.payment_refs, paystack_ref] : pool.payment_refs;

  const { error: updateErr } = await admin
    .from("study_pools")
    .update({
      participants: newParticipants,
      current_count: newCount,
      payment_refs: newRefs,
    })
    .eq("id", pool_id)
    .eq("status", "open"); // race condition guard

  if (updateErr) return bad("Failed to join pool: " + updateErr.message, 500);

  // Log activity
  const { data: profile } = await admin.from("profiles").select("full_name").eq("id", user.id).single();
  await admin.from("activity_feed").insert({
    actor_name: profile?.full_name ?? "A student",
    actor_id: user.id,
    action: "joined a study pool",
    subject: pool.title,
    amount: pool.unit_price,
    emoji: "🛒",
    university: pool.university,
  });

  // Notify organizer of new join
  await admin.from("notifications").insert({
    user_id: pool.organizer_id,
    type: "pool_joined",
    title: "👋 New Pool Member!",
    body: `${profile?.full_name ?? "Someone"} joined "${pool.title}". ${pool.max_capacity - newCount} spots remaining.`,
    data: { pool_id, current_count: newCount, max_capacity: pool.max_capacity },
  });

  return ok({
    success: true,
    current_count: newCount,
    max_capacity: pool.max_capacity,
    spots_remaining: pool.max_capacity - newCount,
    pool_status: newCount >= pool.max_capacity ? "locked" : "open",
  });
});
