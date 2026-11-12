import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const fail = (message) => { throw new Error(message); };
const assertIncludes = (source, value, message) => { if (!source.includes(value)) fail(message); };

const migration = read("supabase/migrations/20261111170000_fix_paystack_refund_webhook_lifecycle.sql");
const recoveryMigration = read("supabase/migrations/20261112100000_paystack_refund_idempotency_recovery.sql");
assertIncludes(migration, "ALTER COLUMN refund_reference DROP NOT NULL", "Existing refund records must accept null pending references");
assertIncludes(migration, "'needs-attention'", "Refund records must support Paystack's needs-attention state");
assertIncludes(migration, "p_amount bigint", "Refund recorder must validate provider amount");
assertIncludes(migration, "p_currency text", "Refund recorder must validate provider currency");
assertIncludes(migration, "v_refund.status IN ('processed','failed','cancelled')", "Terminal refunds must not regress");
assertIncludes(migration, "Active refund is already bound to a different provider reference", "An active refund must not be rebound to another provider reference");
assertIncludes(migration, "GRANT EXECUTE ON FUNCTION public.record_paystack_refund(text,text,text,bigint,text) TO service_role", "Only service role should record provider refunds");
assertIncludes(migration, "FOR UPDATE", "Refund state transitions must lock the transaction");
assertIncludes(migration, "v_refund.transaction_id <> v_tx.id", "Provider refund ids must not cross transaction boundaries");
assertIncludes(migration, "v_refund.updated_at >= v_tx.refund_initiated_at", "A retry must accept new null-reference pending events without replaying stale terminal events");
assertIncludes(migration, "refund_initiated_at = clock_timestamp()", "A new retry must have a timestamp later than the prior failed attempt");
assertIncludes(recoveryMigration, "refund_request_reference", "A stable provider idempotency reference must be persisted on the transaction");
assertIncludes(recoveryMigration, "transactions_refund_request_reference_uidx", "Provider request references must be globally unique");
assertIncludes(recoveryMigration, "v_reference := 'cp_rf_'", "Each new attempt must receive a Paystack-compatible idempotency reference");
assertIncludes(recoveryMigration, "'request_reference', v_reference", "The claim RPC must return the persisted provider reference");
assertIncludes(recoveryMigration, "REVOKE ALL ON FUNCTION public.claim_paystack_refund(uuid) FROM PUBLIC, anon, authenticated", "Only service role may claim refund attempts");

const webhook = read("supabase/functions/paystack-webhook/index.ts");
assertIncludes(webhook, "p_refund_reference: refundReference", "Webhook must pass provider refund identity");
assertIncludes(webhook, 'if (!transactionReference || !status', "Refund events must require a transaction reference but allow a null pending refund reference");
assertIncludes(webhook, 'p_amount: amount', "Webhook must pass refund amount for server-side validation");
assertIncludes(webhook, 'p_currency: currency', "Webhook must pass refund currency for server-side validation");
assertIncludes(webhook, 'admin.rpc("record_paystack_refund"', "Webhook must use the atomic refund recorder");
if (webhook.includes('.from("transactions").update(patch)')) fail("Webhook must not directly overwrite transaction refund state");

const adminRefund = read("supabase/functions/admin-refund-escrow/index.ts");
assertIncludes(adminRefund, "reference: requestReference", "Refund creation must send the persisted idempotency reference to Paystack");
assertIncludes(adminRefund, "findRefundByReference(secret, requestReference)", "Ambiguous requests must reconcile against Paystack by the same reference");
assertIncludes(adminRefund, 'admin.rpc("record_paystack_refund"', "Admin refunds must use the atomic provider refund recorder");
assertIncludes(adminRefund, "claim?.request_reference", "Retry must reuse the existing provider idempotency reference");
assertIncludes(adminRefund, "createResult.response.status === 409", "Paystack duplicate-reference conflicts must reconcile, not fail");
assertIncludes(adminRefund, '["failed","pending","processing","needs-attention","processed"].includes(tx.refund_status ?? "")', "Admin refund endpoint must allow safe reconciliation or retry after escrow cancellation");
assertIncludes(adminRefund, 'admin.rpc("record_paystack_refund"', "Missing provider configuration must record a claimed attempt through the atomic recorder");
if (adminRefund.includes('.from("transactions").update(')) fail("Admin refund must not bypass the atomic recorder for refund state changes");

const dispute = read("supabase/functions/process-dispute/index.ts");
assertIncludes(dispute, 'admin.rpc("record_paystack_refund"', "Dispute refunds must use the atomic provider refund recorder");
assertIncludes(dispute, "reference: requestReference", "Dispute refunds must use the persisted Paystack idempotency reference");
assertIncludes(dispute, "fetchPaystackRefund(secret, requestReference)", "Dispute refund retries must reconcile the same provider reference");
console.log("Paystack refund idempotency regression checks passed (static source invariants).");

const refundReconciler = read("supabase/functions/reconcile-paystack-refunds/index.ts");
assertIncludes(refundReconciler, 'isServiceRoleRequest(req)', "Refund reconciliation must be service-role only");
assertIncludes(refundReconciler, '.in("refund_status", ["pending", "processing", "needs-attention", "needs_attention"])', "Refund reconciliation must only inspect outstanding provider refunds");
assertIncludes(refundReconciler, 'admin.rpc(\n        "record_paystack_refund"', "Refund reconciliation must persist provider state through the atomic recorder");
assertIncludes(refundReconciler, 'fetchRefund(tx.refund_request_reference)', "Refund reconciliation must query Paystack using the persisted idempotency reference");
if (refundReconciler.includes('method: "POST"')) fail("Refund reconciliation must never initiate a new provider refund");

const paymentReconciliationWorkflow = read(".github/workflows/payment-reconciliation.yml");
assertIncludes(paymentReconciliationWorkflow, 'cron: "*/10 * * * *"', "Payment and refund reconciliation must run on the established ten-minute schedule");
assertIncludes(paymentReconciliationWorkflow, 'secrets.SUPABASE_SERVICE_ROLE_KEY', "Scheduled refund reconciliation must use the existing service-role secret contract");
assertIncludes(paymentReconciliationWorkflow, '/functions/v1/reconcile-paystack-refunds', "Scheduled payment reconciliation must invoke the refund reconciler");
assertIncludes(paymentReconciliationWorkflow, '--max-time 900', "Refund reconciliation request must allow the bounded 50-item provider lookup batch to finish");
