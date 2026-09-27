import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { createUserClient, getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);

  const user = await getAuthenticatedUser(req);
  const token = getBearerToken(req);
  if (!user || !token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const transactionId = typeof body?.transaction_id === "string" ? body.transaction_id : "";
  if (!transactionId) return jsonResponse({ error: "Missing transaction_id" }, 400, {}, req);

  const { data: tx, error: txError } = await admin
    .from("transactions")
    .select("id,buyer_id,amount,paystack_ref,status,payment_verified")
    .eq("id", transactionId)
    .maybeSingle();

  if (txError) return jsonResponse({ error: txError.message }, 500, {}, req);
  if (!tx) return jsonResponse({ error: "Transaction not found" }, 404, {}, req);
  if (tx.buyer_id !== user.id) return jsonResponse({ error: "Not authorized" }, 403, {}, req);
  if (!tx.paystack_ref) return jsonResponse({ error: "Transaction has no Paystack reference" }, 400, {}, req);

  if (tx.status === "locked" && tx.payment_verified) {
    return jsonResponse({ success: true, already_verified: true, transaction_id: tx.id }, 200, {}, req);
  }
  if (tx.status !== "pending") {
    return jsonResponse({ error: "Transaction is no longer awaiting payment", status: tx.status }, 409, {}, req);
  }

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY") ?? "";
  if (!secret) return jsonResponse({ error: "Payment service is not configured" }, 500, {}, req);

  const verifyResponse = await fetch(
    "https://api.paystack.co/transaction/verify/" + encodeURIComponent(tx.paystack_ref),
    { headers: { Authorization: `Bearer ${secret}` } }
  );

  const payload = await verifyResponse.json().catch(() => null);
  if (!verifyResponse.ok || !payload?.status || payload?.data?.status !== "success") {
    return jsonResponse({
      success: false,
      verified: false,
      payment_status: payload?.data?.status ?? "unknown"
    }, 200, {}, req);
  }

  const verifiedAmount = Number(payload.data.amount);
  const verifiedReference = payload.data.reference;
  if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount !== Number(tx.amount) || verifiedReference !== tx.paystack_ref) {
    return jsonResponse({ error: "Paystack payment verification mismatch" }, 409, {}, req);
  }

  const { data, error } = await admin.rpc("process_paystack_success", {
    p_webhook_id: tx.paystack_ref,
    p_event_type: "charge.success.reconciliation",
    p_reference: tx.paystack_ref,
    p_amount: verifiedAmount,
    p_transaction_id: tx.id
  });

  if (error) return jsonResponse({ error: error.message }, 409, {}, req);
  return jsonResponse({ ...(data ?? {}), reconciled: true }, 200, {}, req);
});

function serve(handler: (req: Request) => Promise<Response>) {
  Deno.serve(handler);
}
