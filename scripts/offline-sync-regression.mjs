import fs from 'node:fs'

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const sync = read('src/lib/offlineSync.ts')
const engine = read('src/components/OfflineSyncEngine.tsx')
const state = read('src/lib/transactionState.ts')
const app = read('src/App.tsx')
const meetup = read('src/components/meetup/MobileMeetupMode.tsx')

for (const invariant of [
  "row.kind !== 'offline-handoff-receipt'",
  "row.ownerId !== userId",
  "supabase.rpc('confirm_offline_handoff'",
  "status: 'syncing'",
  "status: transient ? 'queued' : 'failed'",
  'nextAttemptAt',
  'MAX_BACKOFF_MS',
]) if (!sync.includes(invariant)) throw new Error(`Offline sync invariant missing: ${invariant}`)

for (const forbidden of ['transfer_plug_credit', 'create_wallet_micro_escrow', 'resolve_wallet_micro_escrow', 'release-escrow', 'create_pending_paystack_transaction', 'process-dispute']) {
  if (sync.includes(forbidden)) throw new Error(`Offline queue must never dispatch financial/privileged operation: ${forbidden}`)
}
if (!engine.includes("window.addEventListener('online'")) throw new Error('Offline sync must resume on browser reconnect')
if (!engine.includes("document.addEventListener('visibilitychange'")) throw new Error('Offline sync must resume when the app becomes visible')
if (!app.includes('<OfflineSyncEngine/>')) throw new Error('Offline sync lifecycle coordinator is not mounted')
if (!meetup.includes('syncOfflineQueue(offlineCommitment.buyer_id)')) throw new Error('Offline handoff must use the centralized sync dispatcher')
if (!state.includes("value.kind!=='offline-handoff-receipt'")) throw new Error('Account cleanup must preserve another user’s pending handoff proof without exposing it')
console.log('Offline synchronization regression checks passed.')
