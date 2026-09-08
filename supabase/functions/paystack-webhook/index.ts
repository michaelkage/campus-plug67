import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type PaystackEvent = {
  event?: string;
  data?: {
    reference?: unknown;
    amount?: unknown;
    metadata?: Record<string, unknown>;
  };
};

async function createHmacSignature(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(message);
  
  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  
  const signature = await crypto.subtle.sign("HMAC", key, messageData);
  
  // Convert to hex
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  // The deployment health-check intentionally does not send a Paystack signature.
  // Keep it ahead of the webhook validation so the endpoint can be warmed safely.
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) {
    return jsonResponse({ status: "warm", ts: Date.now(), fn: "paystack-webhook" }, 200, {}, req);
  }
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  const body = await req.text();
  const signature = req.headers.get("x-paystack-signature") ?? "";
  const secret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
  if (!secret) return jsonResponse({ error: "Server misconfiguration" }, 500, {}, req);

  const expected = await createHmacSignature(secret, body);
  if (expected !== signature) return jsonResponse({ error: "Invalid signature" }, 400, {}, req);

  let event: PaystackEvent;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return jsonResponse({ error: "Invalid JSON payload" }, 400, {}, req);
    event = parsed as PaystackEvent;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400, {}, req);
  }

  if (event.event !== "charge.success") return jsonResponse({ ok: true }, 200, {}, req);
  const reference = event.data?.reference;
  const amount = Number(event.data?.amount);
  const metadata = event.data?.metadata ?? {};
  if (typeof reference !== "string" || !Number.isSafeInteger(amount) || amount <= 0) return jsonResponse({ error: "Invalid payment payload" }, 400, {}, req);

  if (metadata.type !== "marketplace_escrow") {
    if (metadata.type === "plugcredit_topup") return jsonResponse({ error: "Top-up requires a server-issued wallet intent" }, 409, {}, req);
    return jsonResponse({ ok: true }, 200, {}, req);
  }

  const transactionId = typeof metadata.transaction_id === "string" ? metadata.transaction_id : null;
  if (!transactionId) return jsonResponse({ error: "Payment missing transaction_id" }, 400, {}, req);
  const { data, error } = await admin.rpc("process_paystack_success", {
    p_webhook_id: reference,
    p_event_type: event.event,
    p_reference: reference,
    p_amount: amount,
    p_transaction_id: transactionId,
  });
  if (error) {
    console.error("Paystack processing failed", error.message);
    return jsonResponse({ error: error.message }, 400, {}, req);
  }
  return jsonResponse(data ?? { success: true }, 200, {}, req);
});
