export const TRANSACTION_STATES = [
  'PENDING',
  'LOCKED',
  'MEETUP_INITIATED',
  'RELEASE_REQUESTED',
  'RELEASED',
  'CANCELLED',
  'DISPUTED',
  'REFUNDED',
] as const;

export type TransactionState = typeof TRANSACTION_STATES[number];

const transitions: Record<TransactionState, readonly TransactionState[]> = {
  PENDING: ['LOCKED', 'CANCELLED'],
  LOCKED: ['MEETUP_INITIATED', 'CANCELLED', 'DISPUTED', 'REFUNDED'],
  MEETUP_INITIATED: ['RELEASE_REQUESTED', 'DISPUTED', 'CANCELLED'],
  RELEASE_REQUESTED: ['RELEASED', 'DISPUTED', 'CANCELLED'],
  RELEASED: [],
  CANCELLED: [],
  DISPUTED: ['RELEASED', 'REFUNDED'],
  REFUNDED: [],
};

export const canTransition = (from: TransactionState, to: TransactionState) =>
  transitions[from]?.includes(to) ?? false;

export const assertValidTransition = (from: TransactionState, to: TransactionState) => {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid transaction transition: ${from} -> ${to}`);
  }
};

export const getAllowedTransitions = (from: TransactionState) => [...(transitions[from] ?? [])];
