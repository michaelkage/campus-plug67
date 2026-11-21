import { describe, expect, it } from 'vitest'
import { evaluateTransactionCommand, type TransactionActor, type TransactionPolicyContext } from './transactionCommandPolicy'

const buyer: TransactionActor = { id: 'buyer-1', role: 'buyer' }
const seller: TransactionActor = { id: 'seller-1', role: 'seller' }
const admin: TransactionActor = { id: 'admin-1', role: 'admin' }

const tx = (overrides: Partial<TransactionPolicyContext> = {}): TransactionPolicyContext => ({
  id: 'tx-1',
  buyerId: 'buyer-1',
  sellerId: 'seller-1',
  status: 'locked',
  ...overrides,
})

describe('transaction command policy', () => {
  it('allows only the seller to start a funded meetup', () => {
    expect(evaluateTransactionCommand(tx(), seller, { type: 'START_MEETUP' }).allowed).toBe(true)
    expect(evaluateTransactionCommand(tx(), buyer, { type: 'START_MEETUP' }).allowed).toBe(false)
    expect(evaluateTransactionCommand(tx({ status: 'pending' }), seller, { type: 'START_MEETUP' }).allowed).toBe(false)
  })

  it('requires a buyer proof reference for handoff confirmation and never releases funds locally', () => {
    const context = tx({ status: 'meetup_initiated' })
    expect(evaluateTransactionCommand(context, buyer, { type: 'CONFIRM_HANDOFF', proofReference: 'voucher-123456' }).expectedNextStatus)
      .toBe('release_requested')
    expect(evaluateTransactionCommand(context, buyer, { type: 'CONFIRM_HANDOFF', proofReference: 'short' }).allowed).toBe(false)
    expect(evaluateTransactionCommand(context, buyer, { type: 'CONFIRM_HANDOFF', proofReference: 'voucher-123456' }).requiresServerValidation).toBe(true)
  })

  it('enforces the seller-requested 24-hour gate for UI eligibility', () => {
    const context = tx({ status: 'meetup_initiated', meetupInitiatedAt: '2026-11-20T10:00:00.000Z' })
    const actor = seller
    expect(evaluateTransactionCommand(context, actor, { type: 'REQUEST_SELLER_RELEASE' }, Date.parse('2026-11-21T09:59:59.000Z')).allowed).toBe(false)
    expect(evaluateTransactionCommand(context, actor, { type: 'REQUEST_SELLER_RELEASE' }, Date.parse('2026-11-21T10:00:00.000Z')).allowed).toBe(true)
  })

  it('allows a participant dispute only while the authoritative window is open', () => {
    const context = tx({ status: 'release_requested', autoReleaseAt: '2026-11-21T12:00:00.000Z' })
    expect(evaluateTransactionCommand(context, buyer, { type: 'OPEN_DISPUTE', reason: 'Item not as described' }, Date.parse('2026-11-21T11:59:59.000Z')).allowed).toBe(true)
    expect(evaluateTransactionCommand(context, seller, { type: 'OPEN_DISPUTE', reason: 'Handoff issue' }, Date.parse('2026-11-21T12:00:00.000Z')).allowed).toBe(false)
  })

  it('keeps dispute resolution and escrow cancellation behind privileged server actors', () => {
    const disputed = tx({ status: 'disputed' })
    expect(evaluateTransactionCommand(disputed, buyer, { type: 'RESOLVE_DISPUTE', outcome: 'release', resolutionReference: 'case-12345678' }).allowed).toBe(false)
    expect(evaluateTransactionCommand(disputed, admin, { type: 'RESOLVE_DISPUTE', outcome: 'release', resolutionReference: 'case-12345678' }).expectedNextStatus).toBe('released')
    expect(evaluateTransactionCommand(tx(), buyer, { type: 'CANCEL', reason: 'Changed mind' }).allowed).toBe(false)
  })

  it('rejects terminal-state resurrection', () => {
    expect(evaluateTransactionCommand(tx({ status: 'released' }), admin, { type: 'CANCEL', reason: 'late cancellation' }).allowed).toBe(false)
    expect(evaluateTransactionCommand(tx({ status: 'cancelled' }), seller, { type: 'START_MEETUP' }).allowed).toBe(false)
  })
})
