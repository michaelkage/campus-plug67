import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const migration = read('supabase/migrations/20261110153000_fix_escrow_payment_rail_integrity.sql');
const adminRefund = read('supabase/functions/admin-refund-escrow/index.ts');
const disputeFunction = read('supabase/functions/process-dispute/index.ts');

const extract = (name, nextName) => {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  assert.notEqual(start, -1, `Missing replacement for ${name}`);
  const end = nextName
    ? migration.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start + 1)
    : migration.indexOf(`REVOKE ALL ON FUNCTION public.${name}`, start + 1);
  assert.notEqual(end, -1, `Could not isolate ${name}`);
  return migration.slice(start, end);
};

const escrow = extract('process_escrow_action', 'settle_due_paystack_inspections');
const inspection = extract('settle_due_paystack_inspections', 'resolve_dispute_verdict');
const verdict = extract('resolve_dispute_verdict');

const refundBranch = escrow.slice(escrow.indexOf("WHEN 'refund' THEN"), escrow.indexOf("WHEN 'auto_release' THEN"));
assert.match(refundBranch, /refund_status[^\n]*NOT IN \('pending', 'processing', 'processed'\)/);
assert.ok(!refundBranch.includes('INSERT INTO public.plug_credit_ledger'),
  'A Paystack provider refund must not also credit the internal wallet');

const autoReleaseBranch = escrow.slice(escrow.indexOf("WHEN 'auto_release' THEN"), escrow.indexOf('ELSE\n      RAISE EXCEPTION'));
assert.ok(autoReleaseBranch.includes('handshake_receipt_buffer IS NOT NULL'),
  'The generic worker must not settle QR inspection handoffs');
assert.ok(autoReleaseBranch.includes("'needs_attention'"),
  'The generic worker must not release while a refund needs attention');
assert.ok(autoReleaseBranch.includes("INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)"),
  'Paystack auto-release must credit the seller wallet');
assert.ok(autoReleaseBranch.includes("payout_status = 'paid'"),
  'The payout state must only become paid after the seller wallet credit is verified');
assert.ok(autoReleaseBranch.includes('Seller escrow credit could not be verified'),
  'An idempotent replay must verify the existing seller credit before resolving escrow');

assert.ok(escrow.includes("'seller_wallet_credited', p_action = 'auto_release'"));
assert.ok(escrow.includes("'funds_released', p_action = 'auto_release'"));
assert.ok(escrow.includes("'escrow_resolved', p_action = 'auto_release'"));

assert.ok(inspection.includes("t.handshake_receipt_buffer IS NOT NULL"));
assert.ok(inspection.includes("COALESCE(t.refund_status, '') NOT IN"));
assert.ok(inspection.includes("v_tx.refund_status, '') IN"),
  'Inspection settlement must re-check the refund lock after taking the transaction lock');
assert.ok(inspection.includes("INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)"),
  'Paystack inspection settlement must credit the seller wallet');
assert.ok(inspection.includes("payout_status = 'paid'"),
  'Inspection settlement must mark payout paid only after credit verification');
assert.ok(inspection.includes('Seller inspection settlement credit could not be verified'));

const claimantBranch = verdict.slice(verdict.indexOf("IF p_verdict = 'claimant'"), verdict.indexOf("ELSIF p_verdict = 'respondent'"));
const respondentBranch = verdict.slice(verdict.indexOf("ELSIF p_verdict = 'respondent'"), verdict.indexOf('ELSE\n    RAISE EXCEPTION'));
assert.ok(claimantBranch.indexOf('UPDATE public.wallet_escrow_holds') < claimantBranch.indexOf('UPDATE public.transactions'),
  'Wallet refund hold must be resolved before transaction status triggers synchronize it');
assert.ok(respondentBranch.indexOf('UPDATE public.wallet_escrow_holds') < respondentBranch.indexOf('UPDATE public.transactions'),
  'Wallet release hold must be resolved before transaction status triggers synchronize it');
assert.ok(respondentBranch.includes("INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)"),
  'Seller-favourable dispute verdict must settle seller proceeds to the wallet');
assert.ok(respondentBranch.includes("payout_status = 'paid'"),
  'Seller-favourable dispute verdict must align payout state with the wallet credit');

assert.ok(adminRefund.includes('p_action: "refund"'),
  'Admin Paystack refund must continue through the escrow cancellation RPC');
assert.ok(disputeFunction.includes('admin.rpc("resolve_dispute_verdict"'),
  'Dispute verdict must continue through the atomic database resolver');

console.log('Escrow payment-rail integrity regression checks passed.');
