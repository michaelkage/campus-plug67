import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { isServiceRoleRequest, jsonResponse, optionsResponse } from "../_shared/auth.ts";

type Refund = {
  id?: number | string;
  reference?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
};

type Transaction = {
  id: string;
  paystack_ref: string;
  amount: number;
  refund_request_reference: string;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const serviceKey = Deno.env.get("EDGE_FUNCTION_SERVICE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
const admin = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false },
});

function normalizeStatus(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replaceAll("_", "-")
    : "pending";
}

async function fetchRefund(reference: string): Promise<Refund | null> {
  const query = new URLSearchParams({
    reference,
    perPage: "1",
    page: "1",
  });
  const response = await fetch(
    `https://api.paystack.co/refund?${query.toString()}`,
    {
      headers: { Authorization: `Bearer ${paystackSecret}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Paystack refund lookup returned HTTP ${response.status}`);
  }
  const payload = await response.json().catch(() => null);
  if (!payload?.status || !Array.isArray(payload.data)) {
    throw new Error("Paystack returned an invalid refund lookup response");
  }
  return payload.data.find((item: Refund) =>
    typeof item.reference === "string" &&
    item.reference.toLowerCase() === reference.toLowerCase()
  ) ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  }
  if (!supabaseUrl || !serviceKey || !paystackSecret) {
    return jsonResponse({ error: "Refund reconciliation is not configured" }, 500, {}, req);
  }
  if (!isServiceRoleRequest(req)) {
    return jsonResponse({ error: "Forbidden" }, 403, {}, req);
  }

  const { data: transactions, error } = await admin
    .from("transactions")
    .select("id,paystack_ref,amount,refund_request_reference")
    .in("refund_status", ["pending", "processing", "needs-attention", "needs_attention"])
    .not("refund_request_reference", "is", null)
    .not("paystack_ref", "is", null)
    .order("refund_initiated_at", { ascending: true })
    .limit(50);

  if (error) {
    console.error("Could not load pending Paystack refunds", error.message);
    return jsonResponse({ error: "Could not load pending refunds" }, 500, {}, req);
  }

  const results: Array<Record<string, unknown>> = [];
  for (const tx of (transactions ?? []) as Transaction[]) {
    try {
      const refund = await fetchRefund(tx.refund_request_reference);
      if (!refund) {
        results.push({ transaction_id: tx.id, action: "not_yet_visible" });
        continue;
      }

      const amount = Number(refund.amount);
      const currency = typeof refund.currency === "string"
        ? refund.currency.toUpperCase()
        : "";
      if (
        !Number.isSafeInteger(amount) ||
        amount !== Number(tx.amount) ||
        currency !== "NGN" ||
        typeof refund.status !== "string"
      ) {
        results.push({
          transaction_id: tx.id,
          action: "manual_review",
          reason: "Provider refund amount, currency, or status does not match the escrow",
        });
        continue;
      }

      const { data: recorded, error: recordError } = await admin.rpc(
        "record_paystack_refund",
        {
          p_transaction_reference: tx.paystack_ref,
          p_refund_reference: refund.id != null ? String(refund.id) : null,
          p_status: normalizeStatus(refund.status),
          p_amount: amount,
          p_currency: currency,
        },
      );
      if (recordError) {
        console.error("Could not record reconciled Paystack refund", {
          transaction_id: tx.id,
          message: recordError.message,
        });
        results.push({ transaction_id: tx.id, action: "record_failed" });
        continue;
      }

      results.push({
        transaction_id: tx.id,
        action: "reconciled",
        status: recorded?.status ?? normalizeStatus(refund.status),
      });
    } catch (error) {
      console.error("Paystack refund reconciliation deferred", {
        transaction_id: tx.id,
        message: error instanceof Error ? error.message : String(error),
      });
      results.push({ transaction_id: tx.id, action: "deferred" });
    }
  }

  return jsonResponse({
    success: true,
    inspected: transactions?.length ?? 0,
    results,
  }, 200, {}, req);
});
