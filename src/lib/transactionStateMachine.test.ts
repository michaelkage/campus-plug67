import { describe, expect, it } from 'vitest'
import { assertValidTransition, canTransition, getAllowedTransitions } from './transactionStateMachine'
import { deriveTransactionLifecycle } from './transactionLifecycle'

describe('Campus Plug database transaction state machine', () => {
  it('matches the persisted transaction statuses and normal payment-to-handoff path', () => {
    expect(canTransition('pending', 'locked')).toBe(true)
    expect(canTransition('locked', 'meetup_initiated')).toBe(true)
    expect(canTransition('meetup_initiated', 'release_requested')).toBe(true)
    expect(canTransition('release_requested', 'released')).toBe(true)
    expect(getAllowedTransitions('disputed')).toEqual(['released', 'cancelled'])
  })

  it('rejects frontend-only states and terminal-state resurrection', () => {
    expect(() => assertValidTransition('released', 'locked')).toThrow()
    expect(() => assertValidTransition('cancelled', 'pending')).toThrow()
    expect(canTransition('disputed', 'pending')).toBe(false)
  })

  it('keeps a QR handoff in inspection and never equates it with payout', () => {
    const lifecycle = deriveTransactionLifecycle({
      status: 'release_requested',
      handshake_receipt_buffer: '2026-11-10T12:00:00Z',
      auto_release_at: '2026-11-10T14:00:00Z',
      payout_status: 'approved_for_settlement',
    }, Date.parse('2026-11-10T13:00:00Z'))

    expect(lifecycle.phase).toBe('inspection')
    expect(lifecycle.canDispute).toBe(true)
    expect(lifecycle.payout.settled).toBe(false)
    expect(lifecycle.description).toContain('not a payout')
  })

  it('distinguishes seller-requested release from QR inspection', () => {
    const lifecycle = deriveTransactionLifecycle({
      status: 'release_requested',
      handshake_receipt_buffer: null,
      auto_release_at: '2026-11-12T12:00:00Z',
      payout_status: 'pending',
    }, Date.parse('2026-11-10T12:00:00Z'))

    expect(lifecycle.phase).toBe('seller_release_window')
    expect(lifecycle.title).toBe('Seller requested release')
  })

  it('allows either transaction participant to dispute only before the authoritative deadline', () => {
    const tx = { status: 'release_requested', auto_release_at: '2026-11-10T14:00:00Z' }
    expect(deriveTransactionLifecycle(tx, Date.parse('2026-11-10T13:59:59Z')).canDispute).toBe(true)
    expect(deriveTransactionLifecycle(tx, Date.parse('2026-11-10T14:00:00Z')).canDispute).toBe(false)
    expect(deriveTransactionLifecycle({ status: 'locked' }).canDispute).toBe(true)
    expect(deriveTransactionLifecycle({ status: 'meetup_initiated' }).canDispute).toBe(true)
  })

  it('does not claim Paystack payout is complete when transaction resolution precedes settlement', () => {
    const lifecycle = deriveTransactionLifecycle({
      status: 'released',
      payment_method: 'paystack',
      payout_status: 'processing',
    })
    expect(lifecycle.title).toBe('Transaction resolved · payout pending')
    expect(lifecycle.payout.settled).toBe(false)
  })

  it('requires explicit payout confirmation even for Campus Wallet', () => {
    const lifecycle = deriveTransactionLifecycle({ status: 'released', payment_method: 'campus_wallet', payout_status: 'not_applicable' })
    expect(lifecycle.payout.settled).toBe(false)
  })

  it('only reports a completed refund from an explicit refund status', () => {
    expect(deriveTransactionLifecycle({ status: 'cancelled', refund_status: 'succeeded' }).description)
      .toContain('refund has been processed')
    expect(deriveTransactionLifecycle({ status: 'cancelled' }).description)
      .toContain('Check the refund record')
  })
})
