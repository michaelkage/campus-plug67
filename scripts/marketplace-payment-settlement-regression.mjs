import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const migration = read("supabase/migrations/20261022135000_harden_marketplace_payment_settlement.sql");
assert(migration.includes("listing_status IS DISTINCT FROM 'active'"), "Settlement must require an active listing");
assert(migration.includes("FROM public.listings WHERE id = tx.listing_id FOR UPDATE"), "Settlement must lock the listing row");
assert(migration.includes("GET DIAGNOSTICS updated_count = ROW_COUNT"), "Settlement must check update row counts");
assert(migration.includes("updated_count <> 1 THEN RAISE EXCEPTION 'Listing availability changed during settlement'"), "Listing update race must roll back settlement");
assert(migration.includes("tx.status <> 'pending' OR COALESCE(tx.payment_verified, false)"), "Cancelled and otherwise ineligible transactions must not settle");
assert(migration.includes("tx.status = 'locked' AND tx.payment_verified"), "Settled transaction retries must remain idempotent");
assert(migration.includes("GRANT EXECUTE ON FUNCTION public.process_paystack_success(text, text, text, bigint, uuid) TO service_role"), "Settlement RPC must remain service-role-only");

const verify = read("supabase/functions/verify-payment/index.ts");
assert(verify.includes('verifiedCurrency !== "NGN"'), "Buyer-triggered verification must require NGN");
const reconcile = read("supabase/functions/reconcile-pending-payments/index.ts");
assert(reconcile.includes('currency !== "NGN"'), "Scheduled reconciliation must require NGN");
const webhook = read("supabase/functions/paystack-webhook/index.ts");
assert(webhook.includes('String(event.data?.currency || "") !== "NGN"'), "Webhook settlement must require NGN");
console.log("Marketplace payment settlement regression checks passed (static source invariants).");
