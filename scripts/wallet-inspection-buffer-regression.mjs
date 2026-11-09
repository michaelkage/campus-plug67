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
  "'inspection_pending'",
]) includes(genericRelease, value, `Paystack QR handoff must enter inspection: ${value}`)
if (genericRelease.includes('INSERT INTO public.plug_credit_ledger')) {
  fail('Paystack QR confirmation must not credit the seller before inspection ends')
}
includes(migration, 'NEW.handshake_receipt_buffer IS NOT NULL', 'Inspection notifications and scheduled jobs must apply to QR handoffs for every payment method')

for (const value of [
  'CREATE OR REPLACE FUNCTION public.settle_due_wallet_inspections',
  "t.status = 'release_requested'",
  "t.payment_method = 'campus_wallet'",
  "t.auto_release_at <= now()",
  'FOR UPDATE OF h SKIP LOCKED',
  "debit.reason = 'Campus Wallet escrow hold'",
  "debit.amount = -v_tx.amount",
  "public.listings",
  "status = 'reserved'",
  "'Campus Wallet micro-escrow release'",
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
  "tx?.payment_method === 'campus_wallet'",
  'funds remain held while the case is reviewed',
  'updated.handshake_receipt_buffer',
  "tx?.payment_method !== 'campus_wallet'",
]) includes(hook, value, `Wallet inspection UI missing invariant: ${value}`)

includes(hook, "status === 'meetup_initiated'", 'Buyer QR release must only be available before handoff confirmation')
includes(hook, "status === 'release_requested'", 'Buyer dispute must remain available during the inspection state')
includes(meetup, 'Funds remain protected for a 2-hour inspection window', 'QR UI must explain that handoff does not immediately pay the seller')
includes(safeSwap, 'Funds remain locked for a two-hour inspection window', 'Safe Swap must explain the provisional handoff')
includes(safeSwap, 'qrInspection', 'Safe Swap must distinguish QR inspection from seller-requested release')
includes(safeSwap, 'auto_release_at', 'Safe Swap must display the authoritative inspection expiry')
includes(safeSwap, 'Campus Wallet automatically releases the seller payout', 'Safe Swap must explain automatic settlement')
includes(escrowState, "label: 'Handoff / inspection'", 'Escrow progress must show the inspection stage')
includes(listingDetail, 'tx.handshake_receipt_buffer', 'Transaction details must distinguish QR handoff inspection from seller-requested release')
includes(listingDetail, 'process-dispute', 'Campus Wallet dispute action must create a jury case during inspection')

if (!packageJson.scripts['test:platform-integrity'].includes('wallet-inspection-buffer-regression.mjs')) {
  fail('Wallet inspection regression must run in the platform-integrity suite')
}

console.log('Campus Wallet provisional handoff and inspection settlement regression checks passed.')
