import { describe, expect, it } from 'vitest'
import { canTransitionEscrow, presentEscrowStatus } from '@/lib/escrowStatus'

describe('escrow status transformations', () => {
  it('maps each canonical state to the correct UI presentation', () => {
    expect(presentEscrowStatus('pending').label).toBe('VERIFYING PAYMENT')
    expect(presentEscrowStatus('held').tone).toBe('cyan')
    expect(presentEscrowStatus('released').terminal).toBe(true)
    expect(presentEscrowStatus('refunded').terminal).toBe(true)
  })

  it('allows only forward terminal-safe transitions', () => {
    expect(canTransitionEscrow('pending', 'held')).toBe(true)
    expect(canTransitionEscrow('held', 'released')).toBe(true)
    expect(canTransitionEscrow('held', 'refunded')).toBe(true)
    expect(canTransitionEscrow('released', 'held')).toBe(false)
    expect(canTransitionEscrow('refunded', 'released')).toBe(false)
  })
})
