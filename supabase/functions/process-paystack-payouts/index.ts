import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("EDGE_FUNCTION_SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const admin = supabaseUrl && serviceKey
  ? createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })
  : null;

type PaystackTransfer = {
  id?: number | string;
  reference?: string;
  amount?: number | string;
  currency?: string;
  status?: string;
  transfer_code?: string;
  recipient?: string | number | { recipient_code?: string };
  failures?: unknown;
};
type PaystackEnvelope<T> = { status?: boolean; message?: string; data?: T };

type ClaimedTransfer = {
  transfer_id: string;
  transaction_id: string;
  seller_id: string;
  recipient_code: string;
  amount_kobo: number;
  currency: string;
  reference: string;
  attempt_number: number;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function requestPaystack<T>(path: string, init?: RequestInit) {
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${paystackSecret}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as PaystackEnvelope<T> | null;
  return { response, payload };
}

function recipientCode(value: PaystackTransfer["recipient"]): string | null {
  if (typeof value === "string" && /^RCP_[A-Za-z0-9]+$/.test(value)) return value;
  if (value && typeof value === "object" && typeof value.recipient_code === "string") return value.recipient_code;
  return null;
}

function validTransfer(data: PaystackTransfer, claimed: ClaimedTransfer, requireRecipient: boolean) {
  const amount = Number(data.amount);
  if (data.reference !== claimed.reference ||
      !Number.isSafeInteger(amount) ||
      amount !== Number(claimed.amount_kobo) ||
      String(data.currency ?? "").toUpperCase() !== "NGN") return false;
  const actualRecipient = recipientCode(data.recipient);
  return !requireRecipient || actualRecipient === null || actualRecipient === claimed.recipient_code;
}

async function record(claimed: ClaimedTransfer, data: PaystackTransfer, fallbackStatus?: string) {
  const status = typeof data.status === "string" ? data.status.toLowerCase() : fallbackStatus ?? "";
  const { data: result, error } = await admin!.rpc("record_paystack_transfer", {
    p_reference: claimed.reference,
    p_status: status,
    p_amount: Number(data.amount ?? claimed.amount_kobo),
    p_currency: String(data.currency ?? claimed.currency).toUpperCase(),
    p_recipient_code: claimed.recipient_code,
    p_transfer_code: typeof data.transfer_code === "string" ? data.transfer_code : null,
    p_provider_transfer_id: data.id != null ? String(data.id) : null,
    p_message: typeof data.failures === "string" ? data.failures : null,
  });
  if (error) throw new Error(error.message);
  return result;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!admin || !serviceKey || !paystackSecret) return json({ error: "Payout worker is not configured" }, 503);
  if (!isServiceRoleRequest(req)) return json({ error: "Forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const requestedLimit = body && typeof body === "object" ? Number((body as Record<string, unknown>).limit ?? 10) : 10;
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 25) : 10;
  const { data: claimed, error: claimError } = await admin.rpc("claim_seller_payout_transfers", { p_limit: limit });
  if (claimError) return json({ error: "Could not claim eligible seller payouts", detail: claimError.message }, 500);

  const results: Array<Record<string, unknown>> = [];
  for (const item of (claimed ?? []) as ClaimedTransfer[]) {
    try {
      // A previous invocation may have timed out after Paystack accepted the
      // transfer. Always verify the exact persisted reference before POSTing.
      let verified = await requestPaystack<PaystackTransfer>(
        `/transfer/verify/${encodeURIComponent(item.reference)}`,
      );

      if (verified.response.ok && verified.payload?.status === true && verified.payload.data) {
        if (!validTransfer(verified.payload.data, item, true)) {
          results.push({ transaction_id: item.transaction_id, action: "manual_review", reason: "Provider verification did not match the approved amount, currency, reference or recipient" });
          continue;
        }
        const recorded = await record(item, verified.payload.data);
        results.push({ transaction_id: item.transaction_id, action: "reconciled_existing", result: recorded });
        continue;
      }

      if (verified.response.status !== 404) {
        // A failed verification call is not evidence that no transfer exists.
        // Let the lease expire and retry this same reference on the next run.
        results.push({ transaction_id: item.transaction_id, action: "deferred_verification", http_status: verified.response.status });
        continue;
      }

      let initiated: { response: Response; payload: PaystackEnvelope<PaystackTransfer> | null };
      try {
        initiated = await requestPaystack<PaystackTransfer>("/transfer", {
          method: "POST",
          body: JSON.stringify({
            source: "balance",
            amount: item.amount_kobo,
            recipient: item.recipient_code,
            reference: item.reference,
            currency: "NGN",
            reason: `Campus Plug seller payout ${item.transaction_id.slice(0, 8)}`,
          }),
        });
      } catch (error) {
        // Network errors are ambiguous. Do not create a new reference or mark
        // the transfer failed. The lease recovery path retries this same ref.
        console.error("Paystack transfer submission outcome is ambiguous", item.reference, error instanceof Error ? error.message : "unknown error");
        results.push({ transaction_id: item.transaction_id, action: "deferred_ambiguous_submission" });
        continue;
      }

      if (initiated.response.status === 409) {
        verified = await requestPaystack<PaystackTransfer>(
          `/transfer/verify/${encodeURIComponent(item.reference)}`,
        );
        if (verified.response.ok && verified.payload?.status === true && verified.payload.data &&
            validTransfer(verified.payload.data, item, true)) {
          const recorded = await record(item, verified.payload.data);
          results.push({ transaction_id: item.transaction_id, action: "reconciled_duplicate_reference", result: recorded });
        } else {
          results.push({ transaction_id: item.transaction_id, action: "deferred_duplicate_reference" });
        }
        continue;
      }

      if (!initiated.response.ok || initiated.payload?.status !== true || !initiated.payload.data) {
        const message = initiated.payload?.message || "Paystack rejected the transfer request";
        if (initiated.response.status >= 500 || initiated.response.status === 408 || initiated.response.status === 429) {
          results.push({ transaction_id: item.transaction_id, action: "deferred_provider_error", http_status: initiated.response.status });
          continue;
        }
        // Explicit 4xx validation rejection means no transfer was queued.
        const { data: failed, error } = await admin.rpc("record_paystack_transfer", {
          p_reference: item.reference,
          p_status: "failed",
          p_amount: item.amount_kobo,
          p_currency: "NGN",
          p_recipient_code: item.recipient_code,
          p_transfer_code: null,
          p_provider_transfer_id: null,
          p_message: message.slice(0, 500),
        });
        if (error) throw new Error(error.message);
        results.push({ transaction_id: item.transaction_id, action: "provider_rejected", result: failed });
        continue;
      }

      const transfer = initiated.payload.data;
      if (!validTransfer(transfer, item, false)) {
        results.push({ transaction_id: item.transaction_id, action: "manual_review", reason: "Paystack initiation response did not match the approved amount, currency or reference" });
        continue;
      }
      const recorded = await record(item, transfer);
      results.push({ transaction_id: item.transaction_id, action: "submitted", result: recorded });
    } catch (error) {
      console.error("Seller payout processing failed", item.reference, error instanceof Error ? error.message : "unknown error");
      results.push({ transaction_id: item.transaction_id, action: "deferred_internal_error" });
    }
  }

  return json({ success: true, claimed: claimed?.length ?? 0, results });
});
