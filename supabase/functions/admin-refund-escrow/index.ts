import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

type PaystackRefund = {
  id?: number | string;
  reference?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
};

type PaystackEnvelope<T> = {
  status?: boolean;
  message?: string;
  data?: T;
};

async function paystackRequest<T>(
  secret: string,
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; payload: PaystackEnvelope<T> | null }> {
  const response = await fetch(`https://api.paystack.co${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as PaystackEnvelope<T> | null;
  return { response, payload };
}

function normalizedStatus(status: unknown): string {
  return typeof status === "string" ? status.toLowerCase().replaceAll("_", "-") : "pending";
}

async function recordRefund(tx: { paystack_ref: string; amount: number }, refund: PaystackRefund) {
  const refundId = refund.id != null ? String(refund.id) : null;
  return admin.rpc("record_paystack_refund", {
    p_transaction_reference: tx.paystack_ref,
    p_refund_reference: refundId,
    p_status: normalizedStatus(refund.status),
    p_amount: Number(refund.amount ?? tx.amount),
    p_currency: typeof refund.currency === "string" ? refund.currency.toUpperCase() : "NGN",
  });
}

async function findRefundByReference(secret: string, reference: string): Promise<PaystackRefund | null> {
  const query = new URLSearchParams({ reference, perPage: "1", page: "1" });
  const { response, payload } = await paystackRequest<PaystackRefund[]>(secret, `/refund?${query.toString()}`);
  if (!response.ok || !payload?.status || !Array.isArray(payload.data)) return null;
  return payload.data.find((item) => item.reference?.toLowerCase() === reference.toLowerCase()) ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);

  const user = await getAuthenticatedUser(req);
  const token = getBearerToken(req);
  if (!user || !token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
  const role = user.app_metadata?.role;
  if (role !== "admin" && role !== "platform_admin") return jsonResponse({ error: "Platform admin required" }, 403, {}, req);

  const body = await req.json().catch(() => null);
  const transactionId = body && typeof body === "object" && typeof (body as Record<string, unknown>).transaction_id === "string"
    ? (body as Record<string, unknown>).transaction_id as string : "";
  if (!transactionId) return jsonResponse({ error: "Missing transaction_id" }, 400, {}, req);

  const { data: tx, error: txError } = await admin.from("transactions")
    .select("id,listing_id,buyer_id,seller_id,amount,status,payment_method,paystack_ref,refund_status,paystack_refund_id")
    .eq("id", transactionId).single();
  if (txError || !tx) return jsonResponse({ error: "Transaction not found" }, 404, {}, req);
  const retryingCancelledRefund = tx.status === "cancelled" &&
    ["failed","pending","processing","needs-attention","processed"].includes(tx.refund_status ?? "");
  if (!["locked","meetup_initiated","release_requested","disputed"].includes(tx.status) && !retryingCancelledRefund) {
    return jsonResponse({ error: "Transaction cannot be refunded from its current state" }, 400, {}, req);
  }

  if ((tx.payment_method ?? "paystack") === "campus_wallet") {
    if (tx.status === "disputed") {
      return jsonResponse({ error: "Disputed Campus Wallet escrow must be resolved through the dispute verdict flow" }, 409, {}, req);
    }
    const { data, error } = await admin.rpc("admin_refund_wallet_micro_escrow", {
      p_transaction_id: tx.id,
    });
    if (error) return jsonResponse({ error: error.message }, 400, {}, req);
    return jsonResponse(data, 200, {}, req);
  }

  if (!tx.paystack_ref) return jsonResponse({ error: "Paystack reference is missing; refund cannot be initiated safely" }, 409, {}, req);

  const { data: claim, error: claimError } = await admin.rpc("claim_paystack_refund", { p_transaction_id: tx.id });
  if (claimError) return jsonResponse({ error: claimError.message }, 409, {}, req);
  const requestReference = claim?.request_reference as string | undefined;
  if (!requestReference || !/^[A-Za-z0-9_-]{8,64}$/.test(requestReference)) {
    return jsonResponse({ error: "Refund idempotency reference is missing or invalid; manual reconciliation is required" }, 500, {}, req);
  }

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) {
    if (claim.claimed) {
      const { error: failureRecordError } = await recordRefund(tx, {
        status: "failed",
        amount: tx.amount,
        currency: "NGN",
      });
      if (failureRecordError) {
        console.error("Missing Paystack configuration could not be recorded atomically", failureRecordError.message);
        return jsonResponse({ error: "Paystack refund service is not configured and the attempt could not be reconciled safely" }, 500, {}, req);
      }
    }
    return jsonResponse({ error: "Paystack refund service is not configured" }, 500, {}, req);
  }

  // If a previous invocation timed out after Paystack accepted the request,
  // reconcile by our stable reference before attempting the idempotent POST.
  let refund: PaystackRefund | null = null;
  if (!claim.claimed) {
    refund = await findRefundByReference(secret, requestReference);
  }

  if (!refund) {
    let createResult: { response: Response; payload: PaystackEnvelope<PaystackRefund> | null } | null = null;
    try {
      createResult = await paystackRequest<PaystackRefund>(secret, "/refund", {
        method: "POST",
        body: JSON.stringify({
          transaction: tx.paystack_ref,
          amount: tx.amount,
          reference: requestReference,
          customer_note: `Campus Plug refund for ${tx.paystack_ref}`,
          merchant_note: `Campus Plug escrow refund for transaction ${tx.id}`,
        }),
      });
    } catch (error) {
      // A network timeout is ambiguous. Query the same idempotency reference;
      // if Paystack has not indexed it yet, leave the attempt processing.
      console.error("Paystack refund request outcome is ambiguous", error);
      refund = await findRefundByReference(secret, requestReference);
      if (!refund) {
        return jsonResponse({
          error: "Refund request outcome is still being reconciled. No second refund was created; retry this operation to check the same provider reference.",
          refund_status: "processing",
          refund_request_reference: requestReference,
        }, 503, {}, req);
      }
    }

    if (!refund && createResult) {
      if (createResult.response.status === 409) {
        refund = await findRefundByReference(secret, requestReference);
        if (!refund) {
          return jsonResponse({
            error: "Paystack reports this refund reference already exists, but it is not yet retrievable. The attempt remains protected for reconciliation.",
            refund_status: "processing",
            refund_request_reference: requestReference,
          }, 503, {}, req);
        }
      } else if (!createResult.response.ok || !createResult.payload?.status || !createResult.payload.data) {
        const message = createResult.payload?.message || "Paystack rejected the refund request";
        if (createResult.response.status >= 500 || createResult.response.status === 408) {
          return jsonResponse({
            error: "Paystack returned an ambiguous server response. The same idempotency reference is retained for reconciliation.",
            refund_status: "processing",
            refund_request_reference: requestReference,
          }, 503, {}, req);
        }
        const { error: failureRecordError } = await recordRefund(tx, {
          status: "failed",
          amount: tx.amount,
          currency: "NGN",
        });
        if (failureRecordError) {
          console.error("Paystack rejection could not be recorded atomically", failureRecordError.message);
          return jsonResponse({ error: "Paystack rejected the refund, but local state could not be reconciled. The same provider reference is retained for safe recovery." }, 500, {}, req);
        }
        return jsonResponse({ error: message, refund_status: "failed" }, 502, {}, req);
      } else {
        refund = createResult.payload.data;
      }
    }
  }

  if (!refund) {
    return jsonResponse({
      error: "Paystack refund could not yet be confirmed. The attempt remains processing and cannot create a second refund.",
      refund_status: "processing",
      refund_request_reference: requestReference,
    }, 503, {}, req);
  }

  const { data: recordedRefund, error: recordError } = await recordRefund(tx, refund);
  if (recordError) {
    console.error("Paystack refund was initiated but could not be recorded", recordError.message);
    return jsonResponse({
      error: "Paystack refund exists but local state could not be recorded; retry will reconcile the same provider reference.",
      refund_status: "processing",
      refund_request_reference: requestReference,
    }, 500, {}, req);
  }
  if (recordedRefund?.status === "failed" || recordedRefund?.status === "cancelled") {
    return jsonResponse({
      error: "Paystack did not complete the refund. The transaction remains protected from inventory reuse and can be retried after reconciliation.",
      refund_status: recordedRefund.status,
      paystack_refund_id: refund?.id != null ? String(refund.id) : null,
    }, 502, {}, req);
  }

  const { data, error } = await admin.rpc("process_escrow_action", {
    p_transaction_id: tx.id,
    p_action: "refund",
    p_qr_secret: null,
    p_reason: null,
  });
  if (error) return jsonResponse({ error: error.message }, 500, {}, req);
  return jsonResponse({
    ...data,
    refund_status: recordedRefund?.status ?? normalizedStatus(refund.status),
    paystack_refund_id: refund?.id != null ? String(refund.id) : null,
    refund_request_reference: requestReference,
  }, 200, {}, req);
});
