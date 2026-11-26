import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import {
  createUserClient,
  getAuthenticatedUser,
  getBearerToken,
  jsonResponse,
  optionsResponse,
} from "../_shared/auth.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("EDGE_FUNCTION_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const admin = url && serviceKey
  ? createClient(url, serviceKey, { auth: { persistSession: false } })
  : null;

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
  if (value && typeof value === "object" && typeof value.recipient_code === "string") {
    return value.recipient_code;
  }
  return null;
}

function validNote(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 20 && value.trim().length <= 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  if (!url || !admin || !serviceKey || !paystackSecret) {
    return jsonResponse({ error: "Payout operator service is not configured" }, 503, {}, req);
  }

  const token = getBearerToken(req);
  const user = await getAuthenticatedUser(req);
  if (!user || !token) return jsonResponse({ error: "Authentication required" }, 401, {}, req);

  // Do not authorize from client state or user-editable metadata. The database
  // checks the signed app_metadata claim through the caller's own JWT.
  let userClient;
  try {
    userClient = createUserClient(token);
  } catch {
    return jsonResponse({ error: "Operator authorization is unavailable" }, 503, {}, req);
  }
  const { data: isAdmin, error: authorizationError } = await userClient.rpc("is_platform_admin");
  if (authorizationError || isAdmin !== true) {
    return jsonResponse({ error: "Platform admin access required" }, 403, {}, req);
  }

  const { data: rateLimit, error: rateLimitError } = await userClient.rpc("consume_rate_limit", {
    p_scope: "admin-payout-operator",
    p_limit: 20,
    p_window_seconds: 3600,
  });
  if (rateLimitError) return jsonResponse({ error: "Operator action rate limit is unavailable" }, 503, {}, req);
  if (rateLimit?.allowed !== true) return jsonResponse({ error: "Too many payout operations. Try again later." }, 429, {}, req);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const action = body?.action;
  const reference = typeof body?.reference === "string" ? body.reference.trim() : "";
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  const supportTicket = typeof body?.support_ticket === "string" ? body.support_ticket.trim() : "";
  if (!["reconcile", "confirm_not_created"].includes(String(action)) ||
      !/^cp_tr_[a-f0-9]{32}$/.test(reference) ||
      !validNote(note) || supportTicket.length > 120) {
    return jsonResponse({
      error: "A valid payout reference, action and 20-500 character audit note are required",
    }, 400, {}, req);
  }

  const { data: transfer, error: transferError } = await admin
    .from("seller_payout_transfers")
    .select("id,transaction_id,reference,amount_kobo,currency,status,recipient_id,provider_transfer_code,provider_transfer_id,created_at")
    .eq("reference", reference)
    .maybeSingle();
  if (transferError || !transfer) return jsonResponse({ error: "Payout attempt not found" }, 404, {}, req);

  if (action === "confirm_not_created" && transfer.status !== "needs_attention") {
    return jsonResponse({ error: "Only a payout in manual attention can be confirmed as not created" }, 409, {}, req);
  }
  if (action === "reconcile" && !["processing", "pending", "needs_attention"].includes(transfer.status)) {
    return jsonResponse({ error: "Only an outstanding payout can be reconciled" }, 409, {}, req);
  }

  const { data: recipient, error: recipientError } = await admin
    .from("seller_payout_recipients")
    .select("recipient_code")
    .eq("id", transfer.recipient_id)
    .maybeSingle();
  if (recipientError || !recipient?.recipient_code) {
    return jsonResponse({ error: "The original verified recipient snapshot is unavailable" }, 409, {}, req);
  }

  let response: Response;
  let payload: Envelope<TransferData> | null;
  const verifiedAt = new Date().toISOString();
  try {
    response = await fetch(
      "https://api.paystack.co/transfer/verify/" + encodeURIComponent(reference),
      {
        headers: { Authorization: "Bearer " + paystackSecret },
        signal: AbortSignal.timeout(15_000),
      },
    );
    payload = await response.json().catch(() => null) as Envelope<TransferData> | null;
  } catch {
    return jsonResponse({ error: "Paystack verification is unavailable. No payout state was changed." }, 502, {}, req);
  }

  if (response.status === 404) {
    if (action === "reconcile") {
      const { data: auditId, error: auditError } = await admin.rpc("write_seller_payout_operator_audit", {
        p_operator_id: user.id,
        p_reference: reference,
        p_action: "provider_not_found",
        p_note: note,
        p_support_ticket: supportTicket || null,
        p_provider_status: "not_found",
        p_provider_http_status: 404,
        p_provider_verified_at: verifiedAt,
      });
      if (auditError) return jsonResponse({ error: "Provider result could not be audited", detail: auditError.message }, 500, {}, req);
      return jsonResponse({ success: true, resolution: "provider_not_found", audit_id: auditId, state_changed: false }, 200, {}, req);
    }

    if (Date.now() - new Date(transfer.created_at).getTime() < 30 * 60 * 1000 ||
        transfer.provider_transfer_code || transfer.provider_transfer_id) {
      const reason = Date.now() - new Date(transfer.created_at).getTime() < 30 * 60 * 1000
        ? "recovery_rejected_too_early"
        : "recovery_rejected_provider_identifier_present";
      const { error: auditError } = await admin.rpc("write_seller_payout_operator_audit", {
        p_operator_id: user.id,
        p_reference: reference,
        p_action: "recovery_rejected",
        p_note: note,
        p_support_ticket: supportTicket || null,
        p_provider_status: reason,
        p_provider_http_status: 404,
        p_provider_verified_at: verifiedAt,
      });
      if (auditError) return jsonResponse({ error: "Rejected recovery attempt could not be audited", detail: auditError.message }, 500, {}, req);
      return jsonResponse({
        error: reason === "recovery_rejected_too_early"
          ? "Wait at least 30 minutes before confirming that no transfer was created"
          : "A provider transfer identifier already exists. Manual not-created confirmation is blocked.",
      }, 409, {}, req);
    }

    const { data: result, error: recoveryError } = await admin.rpc(
      "confirm_paystack_transfer_not_created_with_operator_audit",
      {
        p_operator_id: user.id,
        p_reference: reference,
        p_note: note,
        p_support_ticket: supportTicket || null,
        p_provider_http_status: 404,
        p_provider_verified_at: verifiedAt,
      },
    );
    if (recoveryError) {
      const { error: auditError } = await admin.rpc("write_seller_payout_operator_audit", {
        p_operator_id: user.id,
        p_reference: reference,
        p_action: "recovery_rejected",
        p_note: note,
        p_support_ticket: supportTicket || null,
        p_provider_status: "recovery_database_guard_rejected",
        p_provider_http_status: 404,
        p_provider_verified_at: verifiedAt,
      });
      if (auditError) console.error("Rejected payout recovery audit could not be persisted", auditError.message);
      return jsonResponse({ error: recoveryError.message }, 409, {}, req);
    }
    return jsonResponse({ success: true, resolution: "provider_confirmed_not_created", result }, 200, {}, req);
  }

  if (!response.ok || payload?.status !== true || !payload.data) {
    return jsonResponse({ error: payload?.message || "Paystack did not return an authoritative transfer record" }, 502, {}, req);
  }

  const data = payload.data;
  const actualAmount = Number(data.amount);
  const actualCurrency = String(data.currency ?? "").toUpperCase();
  const actualRecipient = recipientCode(data.recipient);
  const matches = data.reference === reference &&
    Number.isSafeInteger(actualAmount) &&
    actualAmount === Number(transfer.amount_kobo) &&
    actualCurrency === "NGN" &&
    actualRecipient === recipient.recipient_code;
  const rawStatus = typeof data.status === "string" ? data.status.toLowerCase() : "";
  const supported = ["pending", "success", "failed", "reversed", "otp", "abandoned", "blocked", "rejected", "received", "needs_attention"];
  const normalizedStatus = matches && supported.includes(rawStatus) ? rawStatus : "needs_attention";
  const providerMessage = !matches
    ? "Provider verification mismatch: amount, currency, reference or beneficiary differs from the approved payout"
    : !supported.includes(rawStatus)
      ? "Paystack returned an unsupported transfer status; manual review is required"
      : typeof data.failures === "string" ? data.failures.slice(0, 500) : null;

  const { data: result, error: recordError } = await admin.rpc(
    "record_paystack_transfer_with_operator_audit",
    {
      p_operator_id: user.id,
      p_reference: reference,
      p_status: normalizedStatus,
      // Pass the approved snapshot values, never provider mismatch values, to
      // the financial recorder. A mismatch is quarantined as needs_attention.
      p_amount: transfer.amount_kobo,
      p_currency: transfer.currency,
      p_recipient_code: recipient.recipient_code,
      p_transfer_code: typeof data.transfer_code === "string" ? data.transfer_code : null,
      p_provider_transfer_id: data.id != null ? String(data.id) : null,
      p_message: providerMessage,
      p_note: note,
      p_support_ticket: supportTicket || null,
      p_provider_http_status: response.status,
      p_provider_verified_at: verifiedAt,
    },
  );
  if (recordError) return jsonResponse({ error: "Provider result could not be recorded and audited", detail: recordError.message }, 500, {}, req);

  return jsonResponse({
    success: true,
    resolution: matches ? "provider_reconciled" : "provider_mismatch_quarantined",
    result,
    state_changed: true,
  }, 200, {}, req);
});
