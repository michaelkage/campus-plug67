export const TX_STATUS = Object.freeze({
  PENDING: 'pending',
  LOCKED: 'locked',
  MEETUP_INITIATED: 'meetup_initiated',
  RELEASE_REQUESTED: 'release_requested',
  RELEASED: 'released',
  DISPUTED: 'disputed',
  CANCELLED: 'cancelled',
})

export const TX_STEPS = Object.freeze([
  { key: TX_STATUS.PENDING, label: 'Pay' },
  { key: TX_STATUS.LOCKED, label: 'Locked' },
  { key: TX_STATUS.MEETUP_INITIATED, label: 'Meetup' },
  { key: TX_STATUS.RELEASE_REQUESTED, label: 'Release' },
  { key: TX_STATUS.RELEASED, label: 'Done' },
])

export const TX_STATUS_META = Object.freeze({
  pending: { label: 'Awaiting Payment', icon: '⏳', color: 'amber', step: 0 },
  locked: { label: 'Funds Locked in Escrow', icon: '🔐', color: 'cyan', step: 1 },
  meetup_initiated: { label: 'Meetup Confirmed', icon: '📍', color: 'cyan', step: 2 },
  release_requested: { label: 'Release Requested', icon: '⏰', color: 'amber', step: 3 },
  released: { label: 'Exchange Complete', icon: '✅', color: 'green', step: 4 },
  disputed: { label: 'Under Dispute Review', icon: '🚨', color: 'red', step: -1 },
  cancelled: { label: 'Transaction Cancelled', icon: '❌', color: 'red', step: -1 },
})

export const TERMINAL_TX_STATUSES = Object.freeze([
  TX_STATUS.RELEASED,
  TX_STATUS.CANCELLED,
])

export const isTerminalTransaction = (status) =>
  TERMINAL_TX_STATUSES.includes(status)

export const isProtectedEscrowState = (status) =>
  [TX_STATUS.LOCKED, TX_STATUS.MEETUP_INITIATED, TX_STATUS.RELEASE_REQUESTED].includes(status)

export const isDisputedTransaction = (status) =>
  status === TX_STATUS.DISPUTED
