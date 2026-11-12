import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type PaystackEvent = {
  event?: string;
  data?: {
    reference?: unknown;
    amount?: unknown;
    currency?: unknown;
    metadata?: Record<string, unknown>;
    status?: unknown;
    id?: unknown;
    transfer_code?: unknown;
    recipient?: unknown;
    failures?: unknown;
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

  if (!/^[a-f0-9]{128}$/i.test(signature)) return jsonResponse({ error: "Invalid signature" }, 400, {}, req);
  const expected = await createHmacSignature(secret, body);
  // Compare fixed-length signature bytes without an early-exit string comparison.
  const expectedBytes = new TextEncoder().encode(expected.toLowerCase());
  const suppliedBytes = new TextEncoder().encode(signature.toLowerCase());
  let signatureMismatch = 0;
  for (let i = 0; i < expectedBytes.length; i++) signatureMismatch |= expectedBytes[i] ^ suppliedBytes[i];
  if (signatureMismatch !== 0) return jsonResponse({ error: "Invalid signature" }, 400, {}, req);

  let event: PaystackEvent;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null) return jsonResponse({ error: "Invalid JSON payload" }, 400, {}, req);
    event = parsed as PaystackEvent;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400, {}, req);
  }

  if (event.event === "transfer.success" || event.event === "transfer.failed" || event.event === "transfer.reversed") {
    const data = event.data as Record<string, unknown> | undefined;
    const reference = typeof data?.reference === "string" ? data.reference : null;
    const amount = Number(data?.amount);
    const currency = typeof data?.currency === "string" ? data.currency.toUpperCase() : "";
    const eventStatus = event.event.slice("transfer.".length);
    const payloadStatus = typeof data?.status === "string" ? data.status.toLowerCase() : eventStatus;
    const recipient = data?.recipient;
    const recipientCode =
      typeof recipient === "object" && recipient !== null &&
      typeof (recipient as Record<string, unknown>).recipient_code === "string"
        ? (recipient as Record<string, unknown>).recipient_code as string
        : typeof recipient === "string" && /^RCP_[A-Za-z0-9]+$/.test(recipient)
          ? recipient
          : null;

    if (!reference || !Number.isSafeInteger(amount) || amount <= 0 ||
        currency !== "NGN" || payloadStatus !== eventStatus || !recipientCode) {
      return jsonResponse({ error: "Invalid transfer event payload" }, 400, {}, req);
    }

    const { data: recorded, error } = await admin.rpc("record_paystack_transfer", {
      p_reference: reference,
      p_status: eventStatus,
      p_amount: amount,
      p_currency: currency,
      p_recipient_code: recipientCode,
      p_transfer_code: typeof data?.transfer_code === "string" ? data.transfer_code : null,
      p_provider_transfer_id: data?.id != null ? String(data.id) : null,
      p_message: typeof data?.failures === "string" ? data.failures : null,
    });
    if (error) {
      console.error("Paystack transfer recording failed", error.message);
      return jsonResponse({ error: "Could not record transfer event" }, 500, {}, req);
    }
    return jsonResponse(recorded ?? { ok: true }, 200, {}, req);
  }

  if (event.event?.startsWith("refund.")) {
    const data = event.data as Record<string, unknown> | undefined;
    const nestedTransaction = data?.transaction;
    const transactionReference =
      typeof data?.transaction_reference === "string"
        ? data.transaction_reference
        : typeof nestedTransaction === "object" && nestedTransaction !== null &&
            typeof (nestedTransaction as Record<string, unknown>).reference === "string"
          ? (nestedTransaction as Record<string, unknown>).reference as string
          : null;
    const statusValue = typeof data?.status === "string" ? data.status.toLowerCase().replaceAll("_", "-") : null;
    const eventStatus = event.event.slice("refund.".length).toLowerCase().replaceAll("_", "-");
    const status = statusValue ?? eventStatus;
    // Paystack's refund.pending event legitimately has no refund_reference.
    // Prefer its stable numeric refund id when available; later events may
    // correlate to the pending row by transaction reference.
    const refundReference =
      data?.id != null
        ? String(data.id)
        : typeof data?.refund_reference === "string" && data.refund_reference.length > 0
          ? data.refund_reference
          : null;
    const amount = Number(data?.amount);
    const currency = typeof data?.currency === "string" ? data.currency.toUpperCase() : "";
    const allowedStatuses = ["pending", "processing", "needs-attention", "processed", "failed", "cancelled"];
    if (!transactionReference || !status || !allowedStatuses.includes(status) ||
        !Number.isSafeInteger(amount) || amount <= 0 || currency !== "NGN") {
      return jsonResponse({ error: "Invalid refund event payload" }, 400, {}, req);
    }

    const { data: recorded, error } = await admin.rpc("record_paystack_refund", {
      p_transaction_reference: transactionReference,
      p_refund_reference: refundReference,
      p_status: status,
      p_amount: amount,
      p_currency: currency,
    });
    if (error) {
      console.error("Paystack refund recording failed", error.message);
      return jsonResponse({ error: "Could not record refund event" }, 500, {}, req);
    }
    return jsonResponse(recorded ?? { ok: true }, 200, {}, req);
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

  if (String(event.data?.currency || "") !== "NGN") return jsonResponse({ error: "Unsupported payment currency" }, 400, {}, req);
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
