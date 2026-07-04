// Campus Plug — paystack-webhook Edge Function
// Deploy: supabase functions deploy paystack-webhook
// Set in Paystack dashboard: https://YOUR_PROJECT.supabase.co/functions/v1/paystack-webhook
//
// FIX #3a: Replaced `supabase.rpc("plug_score + 100")` (invalid scalar) with
//          `increment_plug_score` RPC — the DB function atomically bumps the column.
// FIX #3b: Replaced `body:` key with `message:` to match the notifications schema.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { createHmac } from "https://deno.land/std@0.168.0/crypto/mod.ts";

serve(async (req: Request) => {
  // ── Idempotency guard ────────────────────────────────────────────────────────
  // Read body once; we need the raw string for HMAC verification.
  const body = await req.text();
  const signature = req.headers.get("x-paystack-signature") ?? "";
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";

  if (!secret) {
    console.error("PAYSTACK_SECRET_KEY is not set");
    return new Response("Server misconfiguration", { status: 500 });
  }

  // Verify Paystack HMAC-SHA512 signature
  const expectedHash = createHmac("sha512", secret).update(body).digest("hex");
  if (expectedHash !== signature) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(body);
  } catch {
    return new Response("Invalid JSON payload", { status: 400 });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  if (event.event === "charge.success") {
    const { reference, metadata, amount } = event.data ?? {};

    // ── Idempotency: skip already-processed webhooks ─────────────────────────
    const { data: existing } = await admin
      .from("processed_webhooks")
      .select("id")
      .eq("webhook_id", reference)
      .maybeSingle();

    if (existing) {
      return new Response("OK (duplicate)", { status: 200 });
    }

    if (metadata?.type === "marketplace_escrow") {
      // Lock the escrow transaction
      const { error } = await admin
        .from("transactions")
        .update({
          status:           "locked",
          payment_verified: true,
          paystack_ref:     reference,
          locked_at:        new Date().toISOString(),
        })
        .eq("paystack_ref", reference);

      if (error) console.error("Escrow lock error:", error);

    } else if (metadata?.type === "plugcredit_topup") {
      const userId: string = metadata.user_id;

      // FIX #3a: use an RPC to atomically increment plug_score.
      // The DB function signature: increment_plug_score(p_user_id uuid, p_delta int)
      const { error: scoreErr } = await admin.rpc("increment_plug_score", {
        p_user_id: userId,
        p_delta:   100,
      });
      if (scoreErr) {
        // Graceful fallback: read current score, write new value
        const { data: profile } = await admin
          .from("profiles")
          .select("plug_score")
          .eq("id", userId)
          .single();

        if (profile) {
          await admin
            .from("profiles")
            .update({ plug_score: (profile.plug_score ?? 500) + 100 })
            .eq("id", userId);
        }
      }

      // Also credit the ledger so the wallet balance reflects the top-up
      await admin.from("plug_credit_ledger").insert({
        user_id:    userId,
        amount:     amount,           // amount is already in kobo from Paystack
        reason:     "PlugCredit top-up via Paystack",
        reference_id: reference,
      });

      // FIX #3b: column is `message`, NOT `body`
      await admin.from("notifications").insert({
        user_id: userId,
        type:    "credit_topup",
        title:   "💳 PlugCredit Topped Up",
        message: `Your wallet has been credited with ₦${(amount / 100).toLocaleString()}`,
        metadata: { reference, amount },
      });
    }

    // Record webhook as processed (idempotency)
    await admin.from("processed_webhooks").insert({
      webhook_id:  reference,
      event_type:  event.event,
      processed:   true,
    });
  }

  return new Response("OK", { status: 200 });
});
