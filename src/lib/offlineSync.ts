import { supabase } from '@/lib/supabase'
import { listActiveLocalTransactions, removeLocalTransaction, saveLocalTransaction, type LocalTransaction } from '@/lib/transactionState'
import { offlineHandoffReceiptKey } from '@/lib/offlineHandoff'

const MAX_BACKOFF_MS = 5 * 60_000
const BASE_BACKOFF_MS = 2_000
let activeSync: Promise<void> | null = null

function isTransient(error: unknown): boolean {
  if (!navigator.onLine) return true
  const value = error as { status?: number; message?: string; code?: string } | null
  const status = Number(value?.status ?? 0)
  if ([0, 408, 425, 429, 500, 502, 503, 504].includes(status)) return true
  if (error instanceof TypeError) return true
  const message = String(value?.message ?? '').toLowerCase()
  return /network|fetch|timeout|temporar|connection|offline/.test(message)
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(attempts, 8))
}

async function syncHandoffReceipt(row: LocalTransaction, userId: string): Promise<void> {
  if (row.ownerId !== userId || row.kind !== 'offline-handoff-receipt') return
  const payload = row.payload as { transactionId?: unknown; voucherId?: unknown; token?: unknown } | null
  if (!payload || typeof payload.transactionId !== 'string' || typeof payload.voucherId !== 'string' || typeof payload.token !== 'string') {
    await saveLocalTransaction({ ...row, status: 'failed', error: 'Saved handoff proof is malformed and cannot be synchronized.' })
    return
  }
  if (row.id !== offlineHandoffReceiptKey(payload.transactionId)) {
    await saveLocalTransaction({ ...row, status: 'failed', error: 'Saved handoff proof identity does not match its transaction.' })
    return
  }

  const claimed: LocalTransaction = { ...row, status: 'syncing', updatedAt: Date.now(), error: undefined }
  await saveLocalTransaction(claimed)
  try {
    const { data, error } = await supabase.rpc('confirm_offline_handoff', {
      p_transaction_id: payload.transactionId,
      p_voucher_id: payload.voucherId,
      p_token: payload.token,
    })
    if (error) throw error
    const result = data as { success?: boolean; error?: string } | null
    if (!result?.success) throw Object.assign(new Error(result?.error || 'Server did not confirm the handoff proof.'), { permanent: true })
    await removeLocalTransaction(row.id)
    window.dispatchEvent(new CustomEvent('campusplug:offline-sync', { detail: { kind: row.kind, id: row.id, status: 'synced' } }))
  } catch (error) {
    const attempts = (row.attempts ?? 0) + 1
    const transient = isTransient(error) && attempts < 12
    const nextAttemptAt = transient ? Date.now() + retryDelay(attempts - 1) : undefined
    const message = error instanceof Error ? error.message : 'Handoff proof synchronization failed.'
    await saveLocalTransaction({
      ...claimed,
      status: transient ? 'queued' : 'failed',
      attempts,
      nextAttemptAt,
      updatedAt: Date.now(),
      error: message.slice(0, 300),
    })
    window.dispatchEvent(new CustomEvent('campusplug:offline-sync', { detail: { kind: row.kind, id: row.id, status: transient ? 'queued' : 'failed' } }))
  }
}

/**
 * Replays only the explicitly approved, idempotent handoff-proof operation.
 * No wallet, payment, escrow release, dispute, payout, chat-send, or QR-issue
 * command is accepted by this dispatcher.
 */
export function syncOfflineQueue(userId: string): Promise<void> {
  if (!userId || !navigator.onLine) return Promise.resolve()
  if (activeSync) return activeSync
  activeSync = (async () => {
    const rows = await listActiveLocalTransactions(userId)
    for (const row of rows) {
      if (!navigator.onLine) break
      if (row.kind !== 'offline-handoff-receipt') continue
      if (row.status === 'failed') continue
      if (row.status === 'syncing' && Date.now() - row.updatedAt < 60_000) continue
      if ((row.nextAttemptAt ?? 0) > Date.now()) continue
      await syncHandoffReceipt(row, userId)
    }
  })().finally(() => { activeSync = null })
  return activeSync
}
