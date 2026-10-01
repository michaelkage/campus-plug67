import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

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
  if (!["locked","meetup_initiated","release_requested","disputed"].includes(tx.status)) return jsonResponse({ error: "Transaction cannot be refunded from its current state" }, 400, {}, req);

  if ((tx.payment_method ?? "paystack") === "campus_wallet") {
    const { data, error } = await admin.rpc("process_escrow_action", { p_transaction_id: tx.id, p_action: "refund", p_qr_secret: null, p_reason: null });
    if (error) return jsonResponse({ error: error.message }, 400, {}, req);
    return jsonResponse(data, 200, {}, req);
  }

  if (!tx.paystack_ref) return jsonResponse({ error: "Paystack reference is missing; refund cannot be initiated safely" }, 409, {}, req);

  const { data: claim, error: claimError } = await admin.rpc("claim_paystack_refund", { p_transaction_id: tx.id });
  if (claimError) return jsonResponse({ error: claimError.message }, 409, {}, req);
  if (!claim?.claimed) {
    if (claim?.status === "processing" && !claim?.refund_id) {
      return jsonResponse({ error: "A Paystack refund is already being initiated for this transaction; reconcile it before retrying" }, 409, {}, req);
    }
    return jsonResponse({ error: "A Paystack refund is already in progress", refund_status: claim?.status, refund_id: claim?.refund_id }, 409, {}, req);
  }

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY");
  if (!secret) {
    await admin.from("transactions").update({ refund_status: "failed", refund_failure_reason: "Paystack refund service is not configured" }).eq("id", tx.id);
    return jsonResponse({ error: "Paystack refund service is not configured" }, 500, {}, req);
  }

  const response = await fetch("https://api.paystack.co/refund", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      transaction: tx.paystack_ref,
      amount: tx.amount,
      customer_note: `Campus Plug refund for ${tx.paystack_ref}`,
      merchant_note: `Campus Plug escrow refund for transaction ${tx.id}`,
    }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.status) {
    const message = payload?.message || "Paystack rejected the refund request";
    await admin.from("transactions").update({ refund_status: "failed", refund_failure_reason: message }).eq("id", tx.id);
    return jsonResponse({ error: message }, 502, {}, req);
  }

  const refund = payload.data ?? {};
  const refundId = refund.id != null ? String(refund.id) : null;
  const refundStatus = typeof refund.status === "string" ? refund.status : "pending";
  const { error: markError } = await admin.from("transactions").update({
    refund_status: refundStatus, paystack_refund_id: refundId,
    refund_initiated_at: new Date().toISOString(), refund_failure_reason: null,
  }).eq("id", tx.id);
  if (markError) return jsonResponse({ error: "Refund was initiated but transaction state could not be recorded" }, 500, {}, req);

  const { data, error } = await admin.rpc("process_escrow_action", { p_transaction_id: tx.id, p_action: "refund", p_qr_secret: null, p_reason: null });
  if (error) return jsonResponse({ error: error.message }, 500, {}, req);
  return jsonResponse({ ...data, refund_status: refundStatus, paystack_refund_id: refundId }, 200, {}, req);
});