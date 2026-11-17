import { describe, expect, it } from 'vitest'
import {
  TERMINAL_TX_STATUSES,
  TX_STEPS,
  TX_STATUS,
  isDisputedTransaction,
  isProtectedEscrowState,
  isTerminalTransaction,
} from '@/lib/escrowState'

describe('escrow transaction status classification', () => {
  it('treats released and cancelled as terminal', () => {
    expect(isTerminalTransaction(TX_STATUS.RELEASED)).toBe(true)
    expect(isTerminalTransaction(TX_STATUS.CANCELLED)).toBe(true)
    expect([...TERMINAL_TX_STATUSES]).toEqual(['released', 'cancelled'])
  })

  it('never treats an in-flight state as terminal', () => {
    for (const status of [
      TX_STATUS.PENDING,
      TX_STATUS.LOCKED,
      TX_STATUS.MEETUP_INITIATED,
      TX_STATUS.RELEASE_REQUESTED,
      TX_STATUS.DISPUTED,
    ]) {
      expect(isTerminalTransaction(status)).toBe(false)
    }
  })

  it('classifies every money-holding state as protected', () => {
    expect(isProtectedEscrowState(TX_STATUS.LOCKED)).toBe(true)
    expect(isProtectedEscrowState(TX_STATUS.MEETUP_INITIATED)).toBe(true)
    expect(isProtectedEscrowState(TX_STATUS.RELEASE_REQUESTED)).toBe(true)
  })

  it('does not protect funds before lock or after settlement', () => {
    expect(isProtectedEscrowState(TX_STATUS.PENDING)).toBe(false)
    expect(isProtectedEscrowState(TX_STATUS.RELEASED)).toBe(false)
    expect(isProtectedEscrowState(TX_STATUS.CANCELLED)).toBe(false)
    expect(isProtectedEscrowState(TX_STATUS.DISPUTED)).toBe(false)
  })

  it('isolates disputes from both the protected and terminal sets', () => {
    expect(isDisputedTransaction(TX_STATUS.DISPUTED)).toBe(true)
    expect(isProtectedEscrowState(TX_STATUS.DISPUTED)).toBe(false)
    expect(isTerminalTransaction(TX_STATUS.DISPUTED)).toBe(false)
  })

  it('keeps the progress steps in ascending, non-skipping escrow order', () => {
    expect(TX_STEPS.map(step => step.key)).toEqual([
      TX_STATUS.PENDING,
      TX_STATUS.LOCKED,
      TX_STATUS.MEETUP_INITIATED,
      TX_STATUS.RELEASE_REQUESTED,
      TX_STATUS.RELEASED,
    ])
  })
})