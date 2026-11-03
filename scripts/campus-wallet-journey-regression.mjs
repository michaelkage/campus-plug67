import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const read = (file) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const migration = read('supabase/migrations/20261103180000_wire_campus_wallet_escrow_journey.sql');
const listing = read('src/pages/ListingDetail.jsx');
const releaseEdge = read('supabase/functions/release-escrow/index.ts');
const refundEdge = read('supabase/functions/admin-refund-escrow/index.ts');
const safeArrival = read('supabase/functions/safe-arrival/index.ts');
const safeSwapPage = read('src/pages/SafeSwapZone.tsx');
const disputeEdge = read('supabase/functions/process-dispute/index.ts');

assert.ok(migration.includes("current_setting('app.escrow_transition', true) = 'true'"),
  'Sensitive transaction guard must allow only trusted escrow-transition context');
assert.ok(migration.includes("PERFORM set_config('app.escrow_transition', 'true', true)"),
  'Wallet lifecycle transitions must set a transaction-local trusted context');

assert.ok(migration.includes("IF p_action = 'initiate_meetup' THEN"));
assert.ok(migration.includes("Only the seller can initiate the wallet meetup"));
assert.ok(migration.includes("IF p_action = 'release' THEN"));
assert.ok(migration.includes("Only the buyer can release Campus Wallet escrow"));
assert.ok(migration.includes("p_qr_secret IS DISTINCT FROM COALESCE(v_tx.qr_secret, v_tx.release_code)"),
  'Wallet release must validate the seller QR secret without NULL comparison gaps');
assert.ok(migration.includes("v_tx.meetup_initiated_at > now() - interval '24 hours'"),
  'Wallet release must enforce the 24-hour gate server-side');
assert.ok(migration.includes("v_tx.mobile_release_ready_at < now() - interval '10 minutes'"),
  'Wallet release must require a fresh mobile safe-zone check');
assert.ok(migration.includes("CREATE OR REPLACE FUNCTION public.admin_refund_wallet_micro_escrow"));
assert.ok(migration.includes("IF auth.role() <> 'service_role' THEN"));
assert.ok(migration.includes("GRANT EXECUTE ON FUNCTION public.admin_refund_wallet_micro_escrow(uuid) TO service_role"));
assert.ok(migration.includes("tx.status NOT IN ('meetup_initiated', 'release_requested')"),
  'Safe arrival must require an initiated meetup');
const disputeResolverStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.resolve_dispute_verdict');
assert.ok(disputeResolverStart >= 0, 'Dispute verdict resolver must be hardened in this migration');
const disputeResolver = migration.slice(disputeResolverStart);
assert.ok(disputeResolver.includes("l.status IN ('reserved', 'sold')"),
  'Buyer-favourable dispute verdict must restore reserved listings');
assert.ok(!disputeResolver.includes('ON CONFLICT'),
  'Dispute ledger inserts must not infer non-existent partial unique indexes');

assert.ok(listing.includes("tx.payment_method === 'campus_wallet'"));
assert.ok(listing.includes("p_action: 'initiate_meetup'"));
assert.ok(releaseEdge.includes('transaction?.payment_method === "campus_wallet"'));
assert.ok(releaseEdge.includes('p_qr_secret: rpcArgs.p_qr_secret'));
assert.ok(releaseEdge.includes('resolve_wallet_micro_escrow'));
assert.ok(refundEdge.includes('admin_refund_wallet_micro_escrow'));
assert.ok(!refundEdge.includes('admin.rpc("process_escrow_action", { p_transaction_id: tx.id, p_action: "refund"'),
  'Admin Campus Wallet refunds must not call the Paystack-only escrow state machine');
assert.ok(safeArrival.includes('safe-arrival'));
assert.ok(safeSwapPage.includes('tx?.buyer_id===user?.id'),
  'QR release scanner must only render for the buyer');
assert.ok(listing.includes("action: 'open_case'"),
  'Campus Wallet buyer must be able to open a dispute before settlement');
assert.ok(disputeEdge.includes('await executeVerdict(juryCase, finalVerdict)'));
assert.ok(!disputeEdge.includes('update({ status: "decided", verdict: finalVerdict'),
  'Dispute Edge Function must not mark the case decided before atomic settlement');

console.log('Campus Wallet escrow journey regression checks passed.');
