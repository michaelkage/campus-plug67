import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const rows: any[] = []
  return {
    rows,
    rpc: vi.fn(),
    list: vi.fn(async (ownerId: string) => rows.filter(row => row.ownerId === ownerId && row.status !== 'synced')),
    save: vi.fn(async (row: any) => {
      const index = rows.findIndex(value => value.id === row.id)
      if (index >= 0) rows[index] = row
      else rows.push(row)
    }),
    remove: vi.fn(async (id: string) => {
      const index = rows.findIndex(row => row.id === id)
      if (index >= 0) rows.splice(index, 1)
    }),
  }
})
const { rows, rpc, list, save, remove } = mocks

vi.mock('@/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('@/lib/transactionState', () => ({
  listActiveLocalTransactions: mocks.list,
  saveLocalTransaction: mocks.save,
  removeLocalTransaction: mocks.remove,
}))
vi.mock('@/lib/offlineHandoff', () => ({
  offlineHandoffReceiptKey: (id: string) => `offline-handoff-receipt:${id}`,
}))

import { syncOfflineQueue } from './offlineSync'

describe('offline outbox replay policy', () => {
  beforeEach(() => {
    rows.splice(0)
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  })

  it('replays an owner-scoped handoff proof and removes it only after server confirmation', async () => {
    rows.push({ id: 'offline-handoff-receipt:tx-1', ownerId: 'buyer-1', kind: 'offline-handoff-receipt', payload: { transactionId: 'tx-1', voucherId: 'v-1', token: 'secret' }, status: 'queued', updatedAt: Date.now() })
    rpc.mockResolvedValue({ data: { success: true }, error: null })
    await syncOfflineQueue('buyer-1')
    expect(rpc).toHaveBeenCalledWith('confirm_offline_handoff', { p_transaction_id: 'tx-1', p_voucher_id: 'v-1', p_token: 'secret' })
    expect(rows).toHaveLength(0)
  })

  it('never replays another user’s queue rows', async () => {
    rows.push({ id: 'offline-handoff-receipt:tx-2', ownerId: 'buyer-2', kind: 'offline-handoff-receipt', payload: { transactionId: 'tx-2', voucherId: 'v-2', token: 'secret' }, status: 'queued', updatedAt: Date.now() })
    await syncOfflineQueue('buyer-1')
    expect(rpc).not.toHaveBeenCalled()
    expect(rows).toHaveLength(1)
  })

  it('does not dispatch unknown or financial queue operation types', async () => {
    rows.push({ id: 'wallet-transfer:1', ownerId: 'buyer-1', kind: 'wallet-transfer', payload: { amount: 10 }, status: 'queued', updatedAt: Date.now() })
    rows.push({ id: 'chat-send:1', ownerId: 'buyer-1', kind: 'chat-send', payload: { content: 'hello' }, status: 'queued', updatedAt: Date.now() })
    await syncOfflineQueue('buyer-1')
    expect(rpc).not.toHaveBeenCalled()
    expect(rows).toHaveLength(2)
  })

  it('retains a proof for retry when the network is unavailable', async () => {
    rows.push({ id: 'offline-handoff-receipt:tx-3', ownerId: 'buyer-1', kind: 'offline-handoff-receipt', payload: { transactionId: 'tx-3', voucherId: 'v-3', token: 'secret' }, status: 'queued', updatedAt: Date.now() })
    rpc.mockResolvedValue({ data: null, error: Object.assign(new Error('fetch failed'), { status: 0 }) })
    await syncOfflineQueue('buyer-1')
    expect(rows[0].status).toBe('queued')
    expect(rows[0].attempts).toBe(1)
    expect(rows[0].nextAttemptAt).toBeGreaterThan(Date.now())
  })
})
