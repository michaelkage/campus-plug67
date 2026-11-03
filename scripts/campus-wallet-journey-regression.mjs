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
const rpcTypes = read('src/lib/supabase/client.ts');
const mobileMeetup = read('src/components/meetup/MobileMeetupMode.tsx');

assert.ok(migration.includes("current_setting('app.escrow_transition', true) = 'true'"));
assert.ok(migration.includes("PERFORM set_config('app.escrow_transition', 'true', true)"));
assert.ok(migration.includes("IF p_action = 'initiate_meetup' THEN"));
assert.ok(migration.includes('Only the seller can initiate the wallet meetup'));
assert.ok(migration.includes("IF p_action = 'release' THEN"));
assert.ok(migration.includes('Only the buyer can release Campus Wallet escrow'));
assert.ok(migration.includes('handle_transaction_update() atomically marks'));
assert.ok(migration.includes("WHERE id = v_listing_id AND status = 'sold'"));
assert.ok(migration.includes('p_qr_secret IS DISTINCT FROM COALESCE(v_tx.qr_secret, v_tx.release_code)'));
assert.ok(migration.includes("v_tx.meetup_initiated_at > now() - interval '24 hours'"));
assert.ok(migration.includes("v_tx.mobile_release_ready_at < now() - interval '10 minutes'"));
assert.ok(migration.includes('v_tx.seller_safe_zone_id IS DISTINCT FROM v_tx.buyer_safe_zone_id'));
assert.ok(migration.includes('v_tx.seller_location_captured_at < now() - interval \'30 minutes\''));
assert.ok(!migration.includes('seller_arrival_time'));
assert.ok(!migration.includes('buyer_arrival_time'));
assert.ok(migration.includes("v_tx.seller_arrival_time < now() - interval '30 minutes'"));
assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.admin_refund_wallet_micro_escrow'));
assert.ok(migration.includes("IF auth.role() <> 'service_role' THEN"));
assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.admin_refund_wallet_micro_escrow(uuid) TO service_role'));
assert.ok(migration.includes("v_tx.status NOT IN ('locked', 'meetup_initiated', 'release_requested')"));
assert.ok(migration.includes("tx.status NOT IN ('meetup_initiated', 'release_requested')"));

const disputeResolverStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.resolve_dispute_verdict');
assert.ok(disputeResolverStart >= 0);
const disputeResolver = migration.slice(disputeResolverStart);
assert.ok(disputeResolver.includes("l.status IN ('reserved', 'sold')"));
assert.ok(!disputeResolver.includes('ON CONFLICT'));
assert.ok(disputeResolver.includes('Campus Wallet dispute escrow integrity check failed'));
assert.ok(disputeResolver.includes("SET status = 'refunded'"),
  'Buyer-favourable wallet verdict must close the hold as refunded');
assert.ok(disputeResolver.includes("SET status = 'released'"),
  'Seller-favourable wallet verdict must close the hold as released');
assert.ok(disputeResolver.includes("debit.reason = 'Campus Wallet escrow hold'"),
  'Wallet dispute settlement must verify the original debit');

assert.ok(listing.includes("tx.payment_method === 'campus_wallet'"));
assert.ok(listing.includes("p_action: 'initiate_meetup'"));
assert.ok(listing.includes("action: 'open_case'"));
assert.ok(listing.includes("tx.payment_method !== 'campus_wallet' && tx.status === 'meetup_initiated'"));
assert.ok(releaseEdge.includes('transaction?.payment_method === "campus_wallet"'));
assert.ok(releaseEdge.includes('p_qr_secret: rpcArgs.p_qr_secret'));
assert.ok(releaseEdge.includes('resolve_wallet_micro_escrow'));
assert.ok(releaseEdge.includes('payment_method.is.null,payment_method.neq.campus_wallet'),
  'Generic timed auto-release must not process Campus Wallet holds');

const walletRefundStart = refundEdge.indexOf('if ((tx.payment_method ?? "paystack") === "campus_wallet")');
const paystackRefundStart = refundEdge.indexOf('if (!tx.paystack_ref)', walletRefundStart);
const walletRefundBranch = refundEdge.slice(walletRefundStart, paystackRefundStart);
assert.ok(walletRefundBranch.includes('admin_refund_wallet_micro_escrow'));
assert.ok(!walletRefundBranch.includes('process_escrow_action'));

assert.ok(safeArrival.includes('record_safe_arrival_v2'), 'Safe-arrival Edge Function must call the hardened RPC');
assert.ok(safeSwapPage.includes('tx?.buyer_id===user?.id'));
assert.ok(safeSwapPage.includes('sellerCheckinFresh'), 'Buyer QR scanner must wait for a fresh seller Safe Swap check-in');
assert.ok(mobileMeetup.includes('manualQr'), 'Mobile release must have a manual QR fallback');
assert.ok(mobileMeetup.includes('release(manualQr.trim())'), 'Manual QR must use the same server-authorized release path');
assert.ok(rpcTypes.includes('p_qr_secret?:string|null'));
assert.ok(disputeEdge.includes('await executeVerdict(juryCase, finalVerdict)'));
assert.ok(!disputeEdge.includes('update({ status: "decided", verdict: finalVerdict'));
assert.ok(disputeEdge.includes('if (finalVerdict === "split")'));
assert.ok(disputeEdge.includes('status: "escalated"'),
  'Split jury verdicts must escalate without settling held funds');
assert.ok(disputeEdge.includes('Your escrow remains protected while the case is reviewed.'));

console.log('Campus Wallet escrow journey regression checks passed.');