import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const url = Deno.env.get("SUPABASE_URL") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const paystackSecret = Deno.env.get("PAYSTACK_SECRET_KEY") || "";
const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function isServiceRequest(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const apiKey = req.headers.get("apikey") || "";
  return token === serviceKey || apiKey === serviceKey;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!serviceKey || !paystackSecret) return json({ error: "Configuration error" }, 500);
  if (!isServiceRequest(req)) return json({ error: "Forbidden" }, 403);

  const { data: transactions, error } = await admin
    .from("transactions")
    .select("id,amount,paystack_ref,status,created_at")
    .eq("status", "pending")
    .not("paystack_ref", "is", null)
    .lt("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) return json({ error: error.message }, 500);

  const results = [];
  for (const tx of transactions || []) {
    try {
      const paystack = await fetch(
        "https://api.paystack.co/transaction/verify/" + encodeURIComponent(tx.paystack_ref),
        { headers: { Authorization: `Bearer ${paystackSecret}` } },
      );
      const payload = await paystack.json().catch(() => null);
      const providerStatus = payload?.data?.status || "unknown";

      if (!paystack.ok || payload?.status !== true) {
        results.push({ transaction_id: tx.id, action: "deferred", provider_status: providerStatus });
        continue;
      }

      if (providerStatus === "success") {
        const amount = Number(payload.data.amount);
        const reference = payload.data.reference;
        if (!Number.isSafeInteger(amount) || amount !== Number(tx.amount) || reference !== tx.paystack_ref) {
          results.push({ transaction_id: tx.id, action: "manual_review", provider_status: providerStatus });
          continue;
        }

        const { data: processed, error: processError } = await admin.rpc("process_paystack_success", {
          p_webhook_id: tx.paystack_ref,
          p_event_type: "charge.success.reconciliation",
          p_reference: tx.paystack_ref,
          p_amount: amount,
          p_transaction_id: tx.id,
        });

        if (processError) {
          results.push({ transaction_id: tx.id, action: "deferred", provider_status: providerStatus, error: processError.message });
        } else {
          results.push({ transaction_id: tx.id, action: "reconciled", result: processed });
        }
        continue;
      }

      if (providerStatus === "failed" || providerStatus === "abandoned") {
        const { data: cancelled, error: cancelError } = await admin
          .from("transactions")
          .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
          .eq("id", tx.id)
          .eq("status", "pending")
          .select("id,status")
          .maybeSingle();

        if (cancelError) {
          results.push({ transaction_id: tx.id, action: "deferred", provider_status: providerStatus, error: cancelError.message });
        } else {
          results.push({ transaction_id: tx.id, action: cancelled ? "cancelled" : "race_lost", provider_status: providerStatus });
        }
        continue;
      }

      results.push({ transaction_id: tx.id, action: "deferred", provider_status: providerStatus });
    } catch (err) {
      results.push({
        transaction_id: tx.id,
        action: "deferred",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return json({
    success: true,
    inspected: transactions?.length || 0,
    results,
  });
});
