import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const fail = message => { throw new Error(message) }
const includes = (source, value, message) => {
  if (!source.includes(value)) fail(message || `Missing invariant: ${value}`)
}

const migration = read('supabase/migrations/20261109213000_add_wallet_escrow_inspection_buffer.sql')
const hook = read('src/hooks/useEscrow.js')
const meetup = read('src/components/meetup/MobileMeetupMode.tsx')
const safeSwap = read('src/pages/SafeSwapZone.tsx')
const listingDetail = read('src/pages/ListingDetail.jsx')
const disputeFunction = read('supabase/functions/process-dispute/index.ts')
const escrowState = read('src/lib/escrowState.js')
const packageJson = JSON.parse(read('package.json'))

const releaseStart = migration.indexOf("ELSIF p_action = 'release' THEN")
const refundStart = migration.indexOf("ELSIF p_action = 'refund' THEN", releaseStart)
if (releaseStart < 0 || refundStart < 0) fail('Wallet release and refund branches must exist')
const releaseBranch = migration.slice(releaseStart, refundStart)

for (const value of [
  "v_tx.status <> 'meetup_initiated'",
  "v_tx.meetup_initiated_at > now() - interval '24 hours'",
  "p_qr_secret IS DISTINCT FROM COALESCE(v_tx.qr_secret, v_tx.release_code)",
  "SET status = 'release_requested'",
  'auto_release_at = v_inspection_expires_at',
  "interval '2 hours'",
  "handshake_receipt_buffer = now()",
  "'funds_released', false",
]) includes(releaseBranch, value, `QR handoff must enter a two-hour provisional inspection state: ${value}`)

if (releaseBranch.includes('INSERT INTO public.plug_credit_ledger')) {
  fail('Buyer QR confirmation must not credit the seller before the inspection window ends')
}
if (releaseBranch.includes("SET status = 'released'")) {
  fail('Buyer QR confirmation must never finalize the transaction')
}

const genericStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.process_escrow_action')
const genericReleaseStart = migration.indexOf("WHEN 'release' THEN", genericStart)
const genericDisputeStart = migration.indexOf("WHEN 'dispute' THEN", genericReleaseStart)
if (genericStart < 0 || genericReleaseStart < 0 || genericDisputeStart < 0) {
  fail('Generic escrow release must enter the inspection state')
}
const genericRelease = migration.slice(genericReleaseStart, genericDisputeStart)
for (const value of [
  "tx.status = 'release_requested' AND tx.handshake_receipt_buffer IS NOT NULL",
  "SET status = 'release_requested'",
  "auto_release_at = now() + interval '2 hours'",
  'handshake_receipt_buffer = now()',
  'tx.buyer_arrived IS DISTINCT FROM true',
  'tx.mobile_release_ready_at < now() - interval \'10 minutes\'',
  'tx.seller_arrived IS DISTINCT FROM true',
  'tx.seller_location_captured_at < now() - interval \'30 minutes\'',
  'tx.seller_safe_zone_id IS DISTINCT FROM tx.buyer_safe_zone_id',
  "'inspection_pending'",
]) includes(genericRelease, value, `Paystack QR handoff must enter inspection: ${value}`)
if (genericRelease.includes('INSERT INTO public.plug_credit_ledger')) {
  fail('Paystack QR confirmation must not credit the seller before inspection ends')
}
const genericAutoReleaseStart = migration.indexOf("WHEN 'auto_release' THEN", genericDisputeStart)
const genericDispute = migration.slice(genericDisputeStart, genericAutoReleaseStart)
includes(genericDispute, 'Use process-dispute to open a jury case and freeze escrow atomically', 'Legacy dispute action must not bypass atomic jury-case creation')
if (genericDispute.includes('UPDATE public.transactions')) fail('Legacy dispute action must not freeze escrow without creating a jury case')
includes(migration, 'NEW.handshake_receipt_buffer IS NOT NULL', 'Inspection notifications and scheduled jobs must apply to QR handoffs for every payment method')

for (const value of [
  'ALTER TABLE public.jury_cases',
  'ADD COLUMN IF NOT EXISTS dispute_campus text',
  "'escalated'",
  'CREATE OR REPLACE FUNCTION public.open_escrow_dispute_case',
  'FROM public.transactions',
  'FOR UPDATE',
  "v_tx.auto_release_at <= now()",
  "v_case.status IN ('open', 'deliberating', 'appealed', 'escalated')",
  "SET status = 'disputed'",
  "SET status = 'disputed'",
  "REVOKE ALL ON FUNCTION public.open_escrow_dispute_case",
  "GRANT EXECUTE ON FUNCTION public.open_escrow_dispute_case",
]) includes(migration, value, `Atomic dispute workflow missing invariant: ${value}`)

const openCaseStart = disputeFunction.indexOf('if (action === "open_case")')
const openReviewStart = disputeFunction.indexOf('if (action === "open_for_review")', openCaseStart)
if (openCaseStart < 0 || openReviewStart < 0) fail('Dispute open-case handler must exist')
const openCaseHandler = disputeFunction.slice(openCaseStart, openReviewStart)
includes(openCaseHandler, 'admin.rpc("open_escrow_dispute_case"', 'Dispute handler must atomically lock the transaction and open the case')
if (openCaseHandler.includes('.from("jury_cases").insert(') || openCaseHandler.includes('.from("transactions").update(')) {
  fail('Dispute creation and transaction freeze must be one atomic database operation')
}

for (const value of [
  'CREATE OR REPLACE FUNCTION public.settle_due_wallet_inspections',
  'CREATE OR REPLACE FUNCTION public.settle_due_paystack_inspections',
  't.handshake_receipt_buffer IS NOT NULL',
  "t.auto_release_at <= now()",
  "COALESCE(t.payment_method, 'paystack') <> 'campus_wallet'",
  'FOR UPDATE OF t SKIP LOCKED',
  "'Escrow auto-release'",
  "SET status = 'released'",
  "REVOKE ALL ON FUNCTION public.settle_due_paystack_inspections(integer) FROM PUBLIC, anon, authenticated",
  "GRANT EXECUTE ON FUNCTION public.settle_due_paystack_inspections(integer) TO service_role",
  "'campus-paystack-inspection-settlement'",
  "'SELECT public.settle_due_paystack_inspections(100);'",
  "t.status = 'release_requested'",
  't.handshake_receipt_buffer IS NOT NULL',
  'v_tx.handshake_receipt_buffer IS NULL',
  "t.payment_method = 'campus_wallet'",
  "t.auto_release_at <= now()",
  'FOR UPDATE OF h SKIP LOCKED',
  "debit.reason = 'Campus Wallet escrow hold'",
  "debit.amount = -v_tx.amount",
  "public.listings",
  "status = 'reserved'",
  "'Campus Wallet micro-escrow release'",
  "'wallet_escrow_auto_release_after_inspection'",
  "SET status = 'released'",
  "payout_status = 'paid'",
  "REVOKE ALL ON FUNCTION public.settle_due_wallet_inspections(integer) FROM PUBLIC, anon, authenticated",
  "GRANT EXECUTE ON FUNCTION public.settle_due_wallet_inspections(integer) TO service_role",
  "cron.schedule(",
  "'campus-wallet-inspection-settlement'",
  "'* * * * *'",
]) includes(migration, value, `Server settlement missing invariant: ${value}`)

for (const value of [
  "action: 'open_case'",
  "transaction_id: transactionId",
  "supabase.functions.invoke('process-dispute'",
  'funds remain held while the case is reviewed',
  'updated.handshake_receipt_buffer',
  "tx?.payment_method !== 'campus_wallet'",
]) includes(hook, value, `Wallet inspection UI missing invariant: ${value}`)

includes(hook, "status === 'meetup_initiated'", 'Buyer QR release must only be available before handoff confirmation')
includes(hook, "status === 'release_requested'", 'Buyer dispute must remain available during the inspection state')
includes(meetup, 'Funds remain protected for a 2-hour inspection window', 'QR UI must explain that handoff does not immediately pay the seller')
includes(safeSwap, 'Funds remain locked for a two-hour inspection window', 'Safe Swap must explain the provisional handoff')
includes(safeSwap, 'qrInspection', 'Safe Swap must distinguish QR inspection from seller-requested release')
includes(safeSwap, 'QRCodeSVG', 'Seller handoff QR must be available inside Safe Swap')
includes(safeSwap, 'tx.seller_id===user?.id', 'Only the transaction seller can display the handoff QR')
if (listingDetail.includes('QRCodeSVG')) fail('Seller QR must not be exposed outside the verified Safe Swap flow')
includes(safeSwap, 'auto_release_at', 'Safe Swap must display the authoritative inspection expiry')
includes(safeSwap, 'Campus Plug automatically processes the seller payout', 'Safe Swap must explain automatic settlement')
includes(escrowState, "label: 'Handoff / inspection'", 'Escrow progress must show the inspection stage')
includes(listingDetail, 'tx.handshake_receipt_buffer', 'Transaction details must distinguish QR handoff inspection from seller-requested release')
includes(listingDetail, 'process-dispute', 'Campus Wallet dispute action must create a jury case during inspection')
includes(listingDetail, 'Continue to Safe Swap handoff', 'Every buyer must use server-verified Safe Swap arrival before QR handoff')

if (!packageJson.scripts['test:platform-integrity'].includes('wallet-inspection-buffer-regression.mjs')) {
  fail('Wallet inspection regression must run in the platform-integrity suite')
}

console.log('Campus Wallet provisional handoff and inspection settlement regression checks passed.')
