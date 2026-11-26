import { describe, expect, it } from 'vitest'
import { deriveTransactionLifecycle } from '@/lib/transactionLifecycle'

describe('seller payout lifecycle presentation', () => {
  it('does not describe escrow resolution as seller payment', () => {
    const lifecycle = deriveTransactionLifecycle({
      status: 'released',
      payment_method: 'paystack',
      payout_status: 'approved_for_settlement',
    })

    expect(lifecycle.title).toBe('Transaction resolved · payout pending')
    expect(lifecycle.payout.settled).toBe(false)
    expect(lifecycle.payout.title).toBe('Payout processing')
  })

  it('shows provider processing without claiming completion', () => {
    const lifecycle = deriveTransactionLifecycle({
      status: 'released',
      payout_status: 'processing',
    })

    expect(lifecycle.payout.settled).toBe(false)
    expect(lifecycle.payout.title).toBe('Payout processing')
  })

  it('surfaces OTP/manual approval as a distinct seller action', () => {
    const lifecycle = deriveTransactionLifecycle({
      status: 'released',
      payout_status: 'needs_attention',
      payout_failure_reason: 'Paystack transfer requires merchant OTP approval',
    })

    expect(lifecycle.payout.title).toBe('Payout needs manual approval')
    expect(lifecycle.description).toContain('merchant OTP approval')
    expect(lifecycle.payout.settled).toBe(false)
  })

  it('marks seller payment complete only after the paid state', () => {
    const lifecycle = deriveTransactionLifecycle({
      status: 'released',
      payout_status: 'paid',
    })

    expect(lifecycle.title).toBe('Transaction settled')
    expect(lifecycle.payout.settled).toBe(true)
    expect(lifecycle.payout.title).toBe('Bank transfer successful')
    expect(lifecycle.payout.description).toContain('may take additional time')
  })
})
