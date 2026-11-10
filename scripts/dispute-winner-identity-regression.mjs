import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const migration = read("supabase/migrations/20261110170000_fix_dispute_winner_and_refund_claim.sql");
const edge = read("supabase/functions/process-dispute/index.ts");

const claimStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.claim_paystack_refund");
const resolverStart = migration.indexOf("CREATE OR REPLACE FUNCTION public.resolve_dispute_verdict");
const resolverEnd = migration.indexOf("REVOKE ALL ON FUNCTION public.resolve_dispute_verdict", resolverStart);
assert.notEqual(claimStart, -1);
assert.notEqual(resolverStart, -1);
assert.notEqual(resolverEnd, -1);
const claim = migration.slice(claimStart, resolverStart);
const resolver = migration.slice(resolverStart, resolverEnd);

assert.ok(claim.includes("v_tx.paystack_ref IS NULL OR length(btrim(v_tx.paystack_ref)) = 0"),
  "Paystack reference validation must treat the column as text");
assert.ok(!claim.includes("NOT v_tx.paystack_ref"),
  "Text references must never be used as booleans");
assert.ok(migration.includes("GRANT EXECUTE ON FUNCTION public.claim_paystack_refund(uuid) TO service_role"));

assert.ok(resolver.includes("p_verdict IS NULL OR p_verdict NOT IN ('claimant', 'respondent')"));
assert.ok(resolver.includes("v_winner_id := CASE"));
assert.ok(resolver.includes("WHEN p_verdict = 'claimant' THEN v_case.claimant_id"));
assert.ok(resolver.includes("ELSE v_case.respondent_id"));
assert.ok(resolver.includes("v_buyer_won := v_winner_id = v_tx.buyer_id"));
assert.ok(resolver.includes("IF v_buyer_won"));
assert.ok(resolver.includes("payout_status = 'not_applicable'"));
assert.ok(resolver.includes("v_payout_status := 'paid'"));
assert.ok(resolver.includes("v_payout_status := 'approved_for_settlement'"));
assert.ok(resolver.includes("payout_status = v_payout_status"));
assert.ok(resolver.includes("IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN"),
  "Only Campus Wallet seller wins may credit PlugCredit");
assert.ok(resolver.includes("'winner_id', v_winner_id"));
assert.ok(resolver.includes("'winner_role', CASE WHEN v_buyer_won THEN 'buyer' ELSE 'seller' END"));

const executeStart = edge.indexOf("async function executeVerdict(");
const executeEnd = edge.indexOf("\nasync function rewardJuror", executeStart);
assert.ok(executeStart >= 0 && executeEnd > executeStart);
const execute = edge.slice(executeStart, executeEnd);
assert.ok(execute.includes('const winnerId = verdict === "claimant" ? juryCase.claimant_id : juryCase.respondent_id'));
assert.ok(execute.includes('if (winnerId === tx.buyer_id'));
assert.ok(!execute.includes('if (verdict === "claimant")'),
  "Paystack refunds must depend on buyer identity, not claimant label");

console.log("Dispute winner identity regression checks passed.");
