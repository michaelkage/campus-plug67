import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const fail = (message) => { throw new Error(message); };
const assertIncludes = (source, value, message) => { if (!source.includes(value)) fail(message); };

const migration = read("supabase/migrations/20261022130000_track_paystack_refunds_individually.sql");
assertIncludes(migration, "refund_reference text UNIQUE", "Provider refund references must be unique while allowing Paystack's null pending reference");
assertIncludes(migration, "ALTER COLUMN refund_reference DROP NOT NULL", "Existing refund records must accept null pending references");
assertIncludes(migration, "'needs-attention'", "Refund records must support Paystack's needs-attention state");
assertIncludes(migration, "p_amount bigint", "Refund recorder must validate provider amount");
assertIncludes(migration, "p_currency text", "Refund recorder must validate provider currency");
assertIncludes(migration, "REFERENCES public.transactions(id) ON DELETE RESTRICT", "Refund records must retain their transaction");
assertIncludes(migration, "FOR UPDATE", "Refund updates must serialize against transaction/refund rows");
assertIncludes(migration, "refund.status = 'processed' AND p_status <> 'processed'", "Completed refunds must not regress");
assertIncludes(migration, "refund.transaction_reference <> p_transaction_reference", "A refund reference must not be rebound to another transaction");
assertIncludes(migration, "GRANT EXECUTE ON FUNCTION public.record_paystack_refund(text,text,text) TO service_role", "Only service role should record provider refunds");

const webhook = read("supabase/functions/paystack-webhook/index.ts");
assertIncludes(webhook, "p_refund_reference: refundReference", "Webhook must pass provider refund identity");
assertIncludes(webhook, 'if (!transactionReference || !status', "Refund events must require a transaction reference but allow a null pending refund reference");
assertIncludes(webhook, 'p_amount: amount', "Webhook must pass refund amount for server-side validation");
assertIncludes(webhook, 'p_currency: currency', "Webhook must pass refund currency for server-side validation");
assertIncludes(webhook, 'admin.rpc("record_paystack_refund"', "Webhook must use the atomic refund recorder");
if (webhook.includes('.from("transactions").update(patch)')) fail("Webhook must not directly overwrite transaction refund state");
console.log("Paystack refund idempotency regression checks passed (static source invariants).");
