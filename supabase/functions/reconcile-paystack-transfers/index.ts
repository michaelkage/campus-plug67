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
type TransferRow = {
  id: string;
  transaction_id: string;
  reference: string;
  amount_kobo: number;
  currency: string;
  status: string;
  recipient_id: string;
};

function recipientCode(value: TransferData["recipient"]): string | null {
  if (typeof value === "string" && /^RCP_[A-Za-z0-9]+$/.test(value)) return value;
  if (value && typeof value === "object" && typeof value.recipient_code === "string") return value.recipient_code;
  return null;
}

async function verify(reference: string) {
  const response = await fetch("https://api.paystack.co/transfer/verify/" + encodeURIComponent(reference), {
    headers: { Authorization: "Bearer " + secret },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as Envelope<TransferData> | null;
  return { response, payload };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  if (!admin || !serviceKey || !secret) return jsonResponse({ error: "Transfer reconciler is not configured" }, 503, {}, req);
  if (!isServiceRoleRequest(req)) return jsonResponse({ error: "Forbidden" }, 403, {}, req);

  const { data: transfers, error } = await admin
    .from("seller_payout_transfers")
    .select("id,transaction_id,reference,amount_kobo,currency,status,recipient_id")
    .in("status", ["processing", "pending"])
    .order("updated_at", { ascending: true })
    .limit(50);
  if (error) return jsonResponse({ error: "Could not load outstanding transfers" }, 500, {}, req);

  const results: Array<Record<string, unknown>> = [];
  for (const transfer of (transfers ?? []) as TransferRow[]) {
    try {
      const { data: recipient, error: recipientError } = await admin
        .from("seller_payout_recipients")
        .select("recipient_code")
        .eq("id", transfer.recipient_id)
        .single();
      if (recipientError || !recipient?.recipient_code) {
        results.push({ transaction_id: transfer.transaction_id, action: "manual_review_missing_recipient" });
        continue;
      }

      const { response, payload } = await verify(transfer.reference);
      if (response.status === 404) {
        results.push({ transaction_id: transfer.transaction_id, action: "not_yet_visible" });
        continue;
      }
      if (!response.ok || payload?.status !== true || !payload.data) {
        results.push({ transaction_id: transfer.transaction_id, action: "deferred_provider_error", http_status: response.status });
        continue;
      }

      const data = payload.data;
      const actualRecipient = recipientCode(data.recipient);
      const amount = Number(data.amount);
      const matches = data.reference === transfer.reference &&
        Number.isSafeInteger(amount) && amount === Number(transfer.amount_kobo) &&
        String(data.currency ?? "").toUpperCase() === "NGN" &&
        actualRecipient === recipient.recipient_code;
      const status = matches && typeof data.status === "string" ? data.status.toLowerCase() : "needs_attention";
      const { data: recorded, error: recordError } = await admin.rpc("record_paystack_transfer", {
        p_reference: transfer.reference,
        p_status: status,
        p_amount: transfer.amount_kobo,
        p_currency: "NGN",
        p_recipient_code: recipient.recipient_code,
        p_transfer_code: typeof data.transfer_code === "string" ? data.transfer_code : null,
        p_provider_transfer_id: data.id != null ? String(data.id) : null,
        p_message: matches
          ? (typeof data.failures === "string" ? data.failures : null)
          : "Transfer verification mismatch: provider amount, currency, reference or recipient differs from the approved payout",
      });
      if (recordError) throw new Error(recordError.message);

      await admin.from("seller_payout_transfers")
        .update({ last_reconciled_at: new Date().toISOString() })
        .eq("id", transfer.id);
      results.push({
        transaction_id: transfer.transaction_id,
        action: matches ? "reconciled" : "manual_review",
        status: recorded?.status ?? status,
      });
    } catch (error) {
      console.error("Paystack transfer reconciliation failed", transfer.reference, error instanceof Error ? error.message : "unknown error");
      results.push({ transaction_id: transfer.transaction_id, action: "deferred_internal_error" });
    }
  }

  return jsonResponse({ success: true, inspected: transfers?.length ?? 0, results }, 200, {}, req);
});
