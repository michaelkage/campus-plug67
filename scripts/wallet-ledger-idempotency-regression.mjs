import fs from "node:fs";
import path from "node:path";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const credit = read("supabase/migrations/20261022143000_guard_service_wallet_credit_status.sql");
assert(credit.includes("VALUES (p_user_id, p_amount_kobo, 'Campus Wallet funding', v_intent.id)"), "Funding ledger must reference the UUID intent, not the provider's text reference");
assert(!credit.includes("'Campus Wallet funding', p_reference"), "Funding ledger must not pass Paystack's text reference into UUID reference_id");
assert(credit.includes("v_intent.status = 'credited'"), "Funding retries must remain idempotent");
assert(credit.includes("v_intent.status <> 'pending'"), "Rejected funding intents must not be credited");

const migration = read("supabase/migrations/20261022160000_wallet_ledger_idempotency.sql");
assert(migration.includes("UNIQUE INDEX IF NOT EXISTS plug_credit_ledger_wallet_reference_uidx"), "Wallet ledger needs a unique reference/reason index");
assert(migration.includes("DO $"), "Migration must preflight legacy duplicates before index creation");
assert(migration.includes("HAVING count(*) > 1"), "Duplicate preflight must detect repeated reference/reason groups");
assert(migration.includes("Cannot create wallet ledger idempotency index"), "Duplicate preflight must explain why index creation is blocked");
assert(migration.includes("Sample groups:"), "Duplicate preflight must include actionable sample groups");
assert(migration.indexOf("DO $") < migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS plug_credit_ledger_wallet_reference_uidx"), "Duplicate preflight must run before index creation");
for (const reason of [
  "Campus Wallet funding",
  "Campus Wallet escrow hold",
  "Campus Wallet micro-escrow release",
  "Campus Wallet micro-escrow refund",
]) assert(migration.includes("'" + reason + "'"), "Missing idempotency coverage for " + reason);

const escrow = read("supabase/migrations/20261021143000_harden_cross_provider_listing_purchases.sql");
assert(escrow.includes("'Campus Wallet escrow hold', v_tx.id"), "Escrow hold must use the transaction UUID as its idempotency reference");
assert(escrow.includes("'Campus Wallet micro-escrow release', v_hold.transaction_id"), "Release must use transaction UUID as its idempotency reference");
assert(escrow.includes("'Campus Wallet micro-escrow refund', v_hold.transaction_id"), "Refund must use transaction UUID as its idempotency reference");
console.log("Wallet ledger idempotency regression checks passed (static source invariants).");
