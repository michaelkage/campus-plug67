import fs from 'node:fs';
const migration = fs.readFileSync('supabase/migrations/20261121130000_block_refund_during_inflight_payout.sql','utf8');
for (const invariant of [
  "v_tx.payout_status IN ('processing','needs_attention')",
  'reconcile the Paystack transfer before refunding',
  "v_tx.refund_status IN ('pending','processing','needs-attention','processed')",
  'FOR UPDATE',
  'GRANT EXECUTE ON FUNCTION public.claim_paystack_refund(uuid) TO service_role',
]) {
  if (!migration.includes(invariant)) throw new Error(`Refund/payout serialization missing invariant: ${invariant}`);
}
console.log('Refund/payout serialization regression checks passed.');
