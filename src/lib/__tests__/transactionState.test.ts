import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getLocalTransaction,
  listActiveLocalTransactions,
  removeLocalTransaction,
  saveLocalTransaction,
  type LocalTransaction,
} from '@/lib/transactionState'

const ACTIVE_USER = 'user-active'
const OTHER_USER = 'user-other'
const DB_NAME = 'campus-plug-local-state'

const tx = (id: string, ownerId: string, status: LocalTransaction['status'] = 'queued'): LocalTransaction => ({
  id,
  ownerId,
  kind: 'listing',
  payload: { title: id },
  status,
  updatedAt: 1,
})

// The library opens the store per call, so dropping the database between tests
// gives each case a clean backlog without touching production purge behavior.
const resetStore = () =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => resolve()
  })

beforeEach(resetStore)
afterEach(resetStore)

describe('offline transaction ownership', () => {
  it('persists and reads back a locally queued transaction', async () => {
    await saveLocalTransaction(tx('tx-1', ACTIVE_USER))
    expect(await getLocalTransaction('tx-1')).toMatchObject({ id: 'tx-1', ownerId: ACTIVE_USER })
  })

  it('lists only unsynced work for the signed-in owner', async () => {
    await saveLocalTransaction(tx('queued', ACTIVE_USER, 'queued'))
    await saveLocalTransaction(tx('failed', ACTIVE_USER, 'failed'))
    await saveLocalTransaction(tx('synced', ACTIVE_USER, 'synced'))

    const active = await listActiveLocalTransactions(ACTIVE_USER)
    expect(active.map(value => value.id).sort()).toEqual(['failed', 'queued'])
  })

  it("never surfaces another user's backlog when an owner filter is supplied", async () => {
    await saveLocalTransaction(tx('mine', ACTIVE_USER))
    await saveLocalTransaction(tx('theirs', OTHER_USER))

    const mine = await listActiveLocalTransactions(ACTIVE_USER)
    expect(mine.map(value => value.id)).toEqual(['mine'])
  })

  it('purges stale-user backlog before sync so ownership cannot be inherited', async () => {
    const { purgeStaleLocalTransactions } = await import('@/lib/transactionState')

    await saveLocalTransaction(tx('mine', ACTIVE_USER))
    await saveLocalTransaction(tx('stale-1', OTHER_USER))
    await saveLocalTransaction(tx('stale-2', 'user-signed-out'))

    await purgeStaleLocalTransactions(ACTIVE_USER)

    expect(await getLocalTransaction('stale-1')).toBeUndefined()
    expect(await getLocalTransaction('stale-2')).toBeUndefined()
    expect(await getLocalTransaction('mine')).toBeDefined()
  })

  it('keeps the offline store free of stored credentials', async () => {
    await saveLocalTransaction(tx('tx-1', ACTIVE_USER))

    const serialised = JSON.stringify(await getLocalTransaction('tx-1'))
    expect(serialised).not.toMatch(/access_token|refresh_token|authorization|password/i)
  })

  it('removes a record on request', async () => {
    await saveLocalTransaction(tx('tx-1', ACTIVE_USER))
    await removeLocalTransaction('tx-1')
    expect(await getLocalTransaction('tx-1')).toBeUndefined()
  })
})