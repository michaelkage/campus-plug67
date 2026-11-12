import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const migration = read('supabase/migrations/20261110161000_restore_paystack_external_payout.sql');
const refundMigration = read('supabase/migrations/20261111170000_fix_paystack_refund_webhook_lifecycle.sql');
const adminRefund = read('supabase/functions/admin-refund-escrow/index.ts');
const disputeFunction = read('supabase/functions/process-dispute/index.ts');

const extract = (source, name, nextName) => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  assert.notEqual(start, -1, `Missing replacement for ${name}`);
  const nextFunction = nextName
    ? source.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start + 1)
    : -1;
  if (nextName) {
    assert.notEqual(nextFunction, -1, `Could not isolate ${name}`);
    return source.slice(start, nextFunction);
  }
  const terminator = source.indexOf("\n$function$;", start);
  assert.notEqual(terminator, -1, `Could not isolate ${name}`);
  return source.slice(start, terminator + "\n$function$;".length);
};

const escrow = extract(refundMigration, 'process_escrow_action', 'resolve_dispute_verdict');
const inspection = extract(migration, 'settle_due_paystack_inspections', 'resolve_dispute_verdict');
const verdict = extract(refundMigration, 'resolve_dispute_verdict');

const refundBranch = escrow.slice(escrow.indexOf("WHEN 'refund' THEN"), escrow.indexOf("WHEN 'auto_release' THEN"));
assert.match(refundBranch, /refund_status[^\n]*NOT IN \('pending', 'processing', 'needs-attention', 'processed'\)/);
assert.ok(refundBranch.includes("tx.status = 'cancelled' AND tx.refund_status IN"),
  'A failed Paystack refund can be retried after the transaction was cancelled');
assert.ok(refundBranch.includes("IF tx.refund_status = 'processed' THEN"),
  'Cancelled inventory may be restored only after provider-confirmed refund success');
assert.ok(refundMigration.includes("v_refund.status = 'processed' AND v_tx.status = 'cancelled'"),
  'A processed webhook restores inventory when it arrives after escrow cancellation');
assert.ok(!refundBranch.includes('INSERT INTO public.plug_credit_ledger'),
  'A Paystack provider refund must not also credit the internal wallet');

const autoReleaseBranch = escrow.slice(escrow.indexOf("WHEN 'auto_release' THEN"), escrow.indexOf('ELSE\n      RAISE EXCEPTION'));
assert.ok(autoReleaseBranch.includes('handshake_receipt_buffer IS NOT NULL'),
  'The generic worker must not settle QR inspection handoffs');
assert.ok(autoReleaseBranch.includes("'needs_attention'"),
  'The generic worker must not release while a refund needs attention');
assert.ok(!autoReleaseBranch.includes('INSERT INTO public.plug_credit_ledger'),
  'Paystack auto-release must not credit PlugCredit; payout is external');
assert.ok(!autoReleaseBranch.includes("payout_status = 'paid'"),
  'Paystack escrow resolution must not claim external payout is already paid');

assert.ok(escrow.includes("'seller_wallet_credited', false"));
assert.ok(escrow.includes("'funds_released', false"));
assert.ok(escrow.includes("'escrow_resolved', p_action = 'auto_release'"));

assert.ok(inspection.includes("t.handshake_receipt_buffer IS NOT NULL"));
assert.ok(inspection.includes("COALESCE(t.refund_status, '') NOT IN"));
assert.ok(inspection.includes("v_tx.refund_status, '') IN"),
  'Inspection settlement must re-check the refund lock after taking the transaction lock');
assert.ok(!inspection.includes('INSERT INTO public.plug_credit_ledger'),
  'Paystack inspection settlement must leave payout on the external rail');
assert.ok(!inspection.includes("payout_status = 'paid'"),
  'Paystack inspection settlement must not mark external payout paid');

const claimantBranch = verdict.slice(verdict.indexOf("IF p_verdict = 'claimant'"), verdict.indexOf("ELSIF p_verdict = 'respondent'"));
const respondentBranch = verdict.slice(verdict.indexOf("ELSIF p_verdict = 'respondent'"), verdict.indexOf('ELSE\n    RAISE EXCEPTION'));
assert.ok(claimantBranch.includes("IF v_tx.refund_status = 'processed' THEN"),
  'A dispute refund must not reactivate inventory while Paystack is still processing it');
assert.ok(claimantBranch.indexOf('UPDATE public.wallet_escrow_holds') < claimantBranch.indexOf('UPDATE public.transactions'),
  'Wallet refund hold must be resolved before transaction status triggers synchronize it');
assert.ok(respondentBranch.indexOf('UPDATE public.wallet_escrow_holds') < respondentBranch.indexOf('UPDATE public.transactions'),
  'Wallet release hold must be resolved before transaction status triggers synchronize it');
assert.ok(respondentBranch.includes("IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN"));
assert.ok(respondentBranch.includes("INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)"),
  'Campus Wallet seller-favourable verdict must credit held proceeds');
assert.ok(respondentBranch.indexOf("IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN") <
  respondentBranch.indexOf('INSERT INTO public.plug_credit_ledger'),
  'Paystack dispute verdict must not credit the internal wallet');
assert.ok(respondentBranch.includes("IF COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN"),
  'Only Campus Wallet dispute proceeds may settle directly into PlugCredit');
assert.ok(verdict.includes("ELSE 'approved_for_settlement'"),
  'Paystack seller-favourable dispute verdict must remain pending external settlement');
assert.ok(!respondentBranch.includes("payout_status = 'paid'"),
  'Paystack seller-favourable dispute verdict must not claim a completed bank transfer');

assert.ok(adminRefund.includes('retryingCancelledRefund') && adminRefund.includes('["failed","pending","processing","needs-attention","processed"].includes(tx.refund_status ?? "")'),
  'Admin refund flow must allow a safe retry after failure and reconciliation while a provider refund is outstanding');
assert.ok(adminRefund.includes('p_action: "refund"'),
  'Admin Paystack refund must continue through the escrow cancellation RPC');
assert.ok(disputeFunction.includes('admin.rpc("resolve_dispute_verdict"'),
  'Dispute verdict must continue through the atomic database resolver');

console.log('Escrow payment-rail integrity regression checks passed.');
