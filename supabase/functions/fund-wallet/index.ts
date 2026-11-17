import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);

  const user = await getAuthenticatedUser(req);
  const token = getBearerToken(req);
  if (!user || !token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const reference = typeof body?.reference === "string" ? body.reference.trim() : "";
  const amountKobo = Number(body?.amount_kobo);
  if (!reference || !Number.isSafeInteger(amountKobo) || amountKobo <= 0) {
    return jsonResponse({ error: "Invalid wallet funding request" }, 400, {}, req);
  }

  // An existing reference is immutable: never overwrite its owner, amount, or state.
  const { data: existing, error: intentLookupError } = await admin
    .from("wallet_funding_intents")
    .select("id,status,amount_kobo,user_id")
    .eq("reference", reference)
    .maybeSingle();

  if (intentLookupError) return jsonResponse({ error: "Unable to load funding intent" }, 503, {}, req);
  if (existing && existing.user_id !== user.id) {
    return jsonResponse({ error: "Payment reference is owned by another account" }, 403, {}, req);
  }
  if (existing && Number(existing.amount_kobo) !== amountKobo) {
    return jsonResponse({ error: "Funding intent amount does not match" }, 400, {}, req);
  }
  if (existing?.status === "rejected") {
    return jsonResponse({ error: "Funding intent is not eligible for credit" }, 409, {}, req);
  }
  if (existing?.status === "credited") {
    return jsonResponse({
      success: true,
      already_credited: true,
      amount_kobo: existing.amount_kobo,
    }, 200, {}, req);
  }

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) return jsonResponse({ error: "Payment service unavailable" }, 503, {}, req);

  const verify = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" } },
  );
  const payload = await verify.json().catch(() => null);
  const payment = payload?.data;

  if (!verify.ok || payload?.status !== true || payment?.status !== "success") {
    return jsonResponse({ error: "Payment is not verified yet" }, 409, {}, req);
  }
  if (Number(payment.amount) !== amountKobo || String(payment.currency || "") !== "NGN") {
    return jsonResponse({ error: "Verified payment amount or currency does not match" }, 400, {}, req);
  }

  // Do not accept arbitrary successful Paystack transactions as wallet funding.
  // These fields are set by Campus Plug when initializing the wallet payment.
  const metadata = payment.metadata;
  if (
    !metadata ||
    metadata.type !== "campus_wallet_funding" ||
    String(metadata.user_id || "") !== user.id
  ) {
    return jsonResponse({ error: "Payment is not linked to this wallet funding request" }, 403, {}, req);
  }

  if (!existing) return jsonResponse({ error: "Funding intent not found" }, 404, {}, req);

  const { data: credited, error: creditError } = await admin.rpc(
    "credit_wallet_funding_for_user",
    { p_user_id: user.id, p_reference: reference, p_amount_kobo: amountKobo },
  );
  if (creditError) return jsonResponse({ error: "Unable to credit verified wallet funding" }, 500, {}, req);

  return jsonResponse(credited, 200, {}, req);
});
