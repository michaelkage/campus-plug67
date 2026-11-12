import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("EDGE_FUNCTION_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const secret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const admin = url && serviceKey ? createClient(url, serviceKey, { auth: { persistSession: false } }) : null;

type TransferData = {
  id?: number | string;
  reference?: string;
  amount?: number | string;
  currency?: string;
  status?: string;
  transfer_code?: string;
  recipient?: string | number | { recipient_code?: string };
  failures?: unknown;
};
type Envelope<T> = { status?: boolean; message?: string; data?: T };

function recipientCode(value: TransferData["recipient"]): string | null {
  if (typeof value === "string" && /^RCP_[A-Za-z0-9]+$/.test(value)) return value;
  if (value && typeof value === "object" && typeof value.recipient_code === "string") return value.recipient_code;
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  if (!admin || !serviceKey || !secret) return jsonResponse({ error: "Payout recovery is not configured" }, 503, {}, req);
  if (!isServiceRoleRequest(req)) return jsonResponse({ error: "Forbidden" }, 403, {}, req);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const reference = typeof body?.reference === "string" ? body.reference.trim() : "";
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (!reference || body?.confirm_not_created !== true || note.length < 20 || note.length > 500) {
    return jsonResponse({
      error: "A transfer reference, explicit no-transfer confirmation and a 20-500 character support note are required",
    }, 400, {}, req);
  }

  const { data: transfer, error } = await admin
    .from("seller_payout_transfers")
    .select("id,transaction_id,reference,amount_kobo,currency,status,recipient_id,provider_transfer_code,provider_transfer_id,created_at")
    .eq("reference", reference)
    .single();
  if (error || !transfer) return jsonResponse({ error: "Payout attempt not found" }, 404, {}, req);
  if (transfer.status !== "needs_attention") {
    return jsonResponse({ error: "Only a payout marked for manual attention can be resolved here" }, 409, {}, req);
  }
  if (Date.now() - new Date(transfer.created_at).getTime() < 30 * 60 * 1000) {
    return jsonResponse({ error: "Wait at least 30 minutes before manually confirming that no transfer was created" }, 409, {}, req);
  }

  const { data: recipient, error: recipientError } = await admin
    .from("seller_payout_recipients")
    .select("recipient_code")
    .eq("id", transfer.recipient_id)
    .single();
  if (recipientError || !recipient?.recipient_code) {
    return jsonResponse({ error: "The original verified recipient snapshot is unavailable" }, 409, {}, req);
  }

  let response: Response;
  let payload: Envelope<TransferData> | null;
  try {
    response = await fetch("https://api.paystack.co/transfer/verify/" + encodeURIComponent(reference), {
      headers: { Authorization: "Bearer " + secret },
      signal: AbortSignal.timeout(15_000),
    });
    payload = await response.json().catch(() => null) as Envelope<TransferData> | null;
  } catch {
    return jsonResponse({ error: "Paystack verification is unavailable. No payout state was changed." }, 502, {}, req);
  }

  if (response.ok && payload?.status === true && payload.data) {
    const data = payload.data;
    const amount = Number(data.amount);
    const matches = data.reference === reference &&
      Number.isSafeInteger(amount) && amount === Number(transfer.amount_kobo) &&
      String(data.currency ?? "").toUpperCase() === "NGN" &&
      recipientCode(data.recipient) === recipient.recipient_code;
    const rawStatus = typeof data.status === "string" ? data.status.toLowerCase() : "";
    const supported = ["pending","success","failed","reversed","otp","abandoned","blocked","rejected","received","needs_attention"];
    const status = matches && supported.includes(rawStatus) ? rawStatus : "needs_attention";
    const { data: recorded, error: recordError } = await admin.rpc("record_paystack_transfer", {
      p_reference: reference,
      p_status: status,
      p_amount: transfer.amount_kobo,
      p_currency: "NGN",
      p_recipient_code: recipient.recipient_code,
      p_transfer_code: typeof data.transfer_code === "string" ? data.transfer_code : null,
      p_provider_transfer_id: data.id != null ? String(data.id) : null,
      p_message: !matches
        ? "Manual verification mismatch: provider amount, currency, reference or recipient differs from the approved payout"
        : !supported.includes(rawStatus)
          ? "Paystack returned an unsupported transfer status during manual verification"
          : (typeof data.failures === "string" ? data.failures : null),
    });
    if (recordError) return jsonResponse({ error: "Provider status could not be recorded", detail: recordError.message }, 500, {}, req);
    return jsonResponse({ success: true, resolution: matches ? "provider_verified" : "manual_review", result: recorded }, 200, {}, req);
  }

  if (response.status !== 404) {
    return jsonResponse({ error: payload?.message || "Paystack did not conclusively verify the transfer" }, 502, {}, req);
  }
  if (transfer.provider_transfer_code || transfer.provider_transfer_id) {
    return jsonResponse({
      error: "Paystack did not return the transfer, but a provider transfer identifier was already recorded. Manual not-created confirmation is blocked.",
    }, 409, {}, req);
  }

  const { data: result, error: resolveError } = await admin.rpc("confirm_paystack_transfer_not_created", {
    p_reference: reference,
    p_note: note,
  });
  if (resolveError) return jsonResponse({ error: resolveError.message }, 409, {}, req);
  return jsonResponse({ success: true, resolution: "provider_confirmed_not_created", result }, 200, {}, req);
});
