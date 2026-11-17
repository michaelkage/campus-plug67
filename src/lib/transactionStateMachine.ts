import { TRANSACTION_STATUSES, type TransactionStatus } from './transactionLifecycle'

export const TRANSACTION_STATES = TRANSACTION_STATUSES
export type { TransactionStatus }

const transitions: Record<TransactionStatus, readonly TransactionStatus[]> = {
  pending: ['locked', 'cancelled'],
  locked: ['meetup_initiated', 'disputed', 'cancelled'],
  meetup_initiated: ['release_requested', 'disputed', 'cancelled'],
  release_requested: ['released', 'disputed', 'cancelled'],
  disputed: ['released', 'cancelled'],
  released: [],
  cancelled: [],
}

export const canTransition = (from: TransactionStatus, to: TransactionStatus) =>
  transitions[from]?.includes(to) ?? false

export const assertValidTransition = (from: TransactionStatus, to: TransactionStatus) => {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid transaction transition: ${from} -> ${to}`)
  }
}

export const getAllowedTransitions = (from: TransactionStatus) => [...(transitions[from] ?? [])]
