import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { jsonResponse, optionsResponse } from "../_shared/auth.ts";

const url = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

function response(req: Request, body: unknown, status = 200) {
  return jsonResponse(body, status, {}, req);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method === "GET" && new URL(req.url).pathname.endsWith("/ping")) return response(req, { status: "warm", ts: Date.now(), fn: "verify-payment" });
  if (req.method !== "POST") return response(req, { error: "Method not allowed" }, 405);

  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return response(req, { error: "Unauthorized" }, 401);

  const { data: authData, error: authError } = await admin.auth.getUser(token);
  const user = authData.user;
  if (authError || !user) return response(req, { error: "Unauthorized" }, 401);

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const transactionId = typeof body?.transaction_id === "string" ? body.transaction_id : "";
  if (!transactionId) return response(req, { error: "Missing transaction_id" }, 400);

  const { data: tx, error: txError } = await admin.from("transactions")
    .select("id,buyer_id,amount,paystack_ref,status,payment_verified")
    .eq("id", transactionId).maybeSingle();

  if (txError) return response(req, { error: txError.message }, 500);
  if (!tx) return response(req, { error: "Transaction not found" }, 404);
  if (tx.buyer_id !== user.id) return response(req, { error: "Not authorized" }, 403);
  if (!tx.paystack_ref) return response(req, { error: "Transaction has no Paystack reference" }, 400);

  if (tx.status === "locked" && tx.payment_verified) {
    return response(req, { success: true, already_verified: true, transaction_id: tx.id });
  }
  if (tx.status !== "pending") {
    return response(req, { error: "Transaction is no longer awaiting payment", status: tx.status }, 409);
  }

  const secret = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
  if (!secret) return response(req, { error: "Payment service is not configured" }, 500);

  const paystack = await fetch("https://api.paystack.co/transaction/verify/" + encodeURIComponent(tx.paystack_ref), {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const payload = await paystack.json().catch(() => null);

  if (!paystack.ok || payload?.status !== true || payload?.data?.status !== "success") {
    return response(req, { success: false, verified: false, payment_status: payload?.data?.status ?? "unknown" });
  }

  const verifiedAmount = Number(payload.data.amount);
  const verifiedReference = payload.data.reference;
  if (!Number.isSafeInteger(verifiedAmount) || verifiedAmount !== Number(tx.amount) || verifiedReference !== tx.paystack_ref) {
    return response(req, { error: "Paystack payment verification mismatch" }, 409);
  }

  const { data, error } = await admin.rpc("process_paystack_success", {
    p_webhook_id: tx.paystack_ref,
    p_event_type: "charge.success.reconciliation",
    p_reference: tx.paystack_ref,
    p_amount: verifiedAmount,
    p_transaction_id: tx.id,
  });

  if (error) return response(req, { error: error.message }, 409);
  return response({ ...(data ?? {}), reconciled: true });
});
