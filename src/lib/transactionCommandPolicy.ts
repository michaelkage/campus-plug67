import { canOpenTransactionDispute, type TransactionStatus } from './transactionLifecycle'

export type TransactionActor = Readonly<{
  id: string
  role: 'buyer' | 'seller' | 'admin' | 'system'
}>

export type TransactionPolicyContext = Readonly<{
  id: string
  buyerId: string
  sellerId: string
  status: TransactionStatus | 'completed' | 'unknown'
  meetupInitiatedAt?: string | null
  autoReleaseAt?: string | null
  handoffConfirmed?: boolean
}>

export type TransactionCommand =
  | Readonly<{ type: 'VERIFY_PAYMENT'; providerReference: string }>
  | Readonly<{ type: 'START_MEETUP' }>
  | Readonly<{ type: 'CONFIRM_HANDOFF'; proofReference: string }>
  | Readonly<{ type: 'REQUEST_SELLER_RELEASE' }>
  | Readonly<{ type: 'OPEN_DISPUTE'; reason: string }>
  | Readonly<{ type: 'RESOLVE_DISPUTE'; outcome: 'release' | 'refund'; resolutionReference: string }>
  | Readonly<{ type: 'CANCEL'; reason: string }>

export type TransactionCommandDecision = Readonly<{
  allowed: boolean
  command: TransactionCommand['type']
  reason: string
  /** Client policy is presentation guidance; the server must re-check every command. */
  requiresServerValidation: true
  expectedNextStatus?: TransactionStatus
}>

const deny = (command: TransactionCommand['type'], reason: string): TransactionCommandDecision => ({
  allowed: false,
  command,
  reason,
  requiresServerValidation: true,
})

const allow = (
  command: TransactionCommand['type'],
  reason: string,
  expectedNextStatus?: TransactionStatus,
): TransactionCommandDecision => ({
  allowed: true,
  command,
  reason,
  expectedNextStatus,
  requiresServerValidation: true,
})

function isParticipant(actor: TransactionActor, tx: TransactionPolicyContext) {
  return actor.id === tx.buyerId || actor.id === tx.sellerId
}

function hasValidReference(value: string | undefined) {
  return typeof value === 'string' && value.trim().length >= 8
}

/**
 * Evaluates whether an action should be offered in the UI.
 *
 * This function is intentionally not an authorization boundary. RPCs and Edge
 * Functions remain authoritative for identity, voucher validation, deadlines,
 * payment-provider state, dispute evidence and ledger mutations.
 */
export function evaluateTransactionCommand(
  tx: TransactionPolicyContext,
  actor: TransactionActor,
  command: TransactionCommand,
  now = Date.now(),
): TransactionCommandDecision {
  switch (command.type) {
    case 'VERIFY_PAYMENT':
      if (actor.role !== 'system') return deny(command.type, 'Payment verification is performed by the trusted payment backend.')
      if (tx.status !== 'pending') return deny(command.type, 'Only a pending transaction can be payment-verified.')
      if (!hasValidReference(command.providerReference)) return deny(command.type, 'A valid provider reference is required.')
      return allow(command.type, 'Payment verification can be requested.', 'locked')

    case 'START_MEETUP':
      if (actor.role !== 'seller' || actor.id !== tx.sellerId) return deny(command.type, 'Only the transaction seller can start the meetup.')
      if (tx.status !== 'locked') return deny(command.type, 'Meetup can only start after escrow funding is confirmed.')
      return allow(command.type, 'The seller can start the protected handoff.', 'meetup_initiated')

    case 'CONFIRM_HANDOFF':
      if (actor.role !== 'buyer' || actor.id !== tx.buyerId) return deny(command.type, 'Only the buyer can confirm receipt.')
      if (tx.status !== 'meetup_initiated') return deny(command.type, 'Handoff confirmation is only available during an active meetup.')
      if (!hasValidReference(command.proofReference)) return deny(command.type, 'A valid one-time handoff proof is required.')
      return allow(command.type, 'The handoff proof can be submitted for server verification.', 'release_requested')

    case 'REQUEST_SELLER_RELEASE': {
      if (actor.role !== 'seller' || actor.id !== tx.sellerId) return deny(command.type, 'Only the seller can request release.')
      if (tx.status !== 'meetup_initiated') return deny(command.type, 'Seller release can only be requested before buyer handoff confirmation.')
      const startedAt = tx.meetupInitiatedAt ? Date.parse(tx.meetupInitiatedAt) : Number.NaN
      if (!Number.isFinite(startedAt)) return deny(command.type, 'The server meetup timestamp is unavailable.')
      if (startedAt + 24 * 60 * 60 * 1000 > now) return deny(command.type, 'The 24-hour seller release gate has not elapsed.')
      return allow(command.type, 'The seller release request can be submitted for server validation.', 'release_requested')
    }

    case 'OPEN_DISPUTE':
      if (!isParticipant(actor, tx) || !['buyer', 'seller'].includes(actor.role)) return deny(command.type, 'Only the buyer or seller can open a transaction dispute.')
      if (!command.reason.trim()) return deny(command.type, 'A dispute reason is required.')
      if (!canOpenTransactionDispute({
        status: tx.status,
        auto_release_at: tx.autoReleaseAt ?? null,
      }, now)) return deny(command.type, 'The dispute window is closed or the transaction is not disputable.')
      return allow(command.type, 'The dispute can be submitted. The server will freeze settlement atomically.', 'disputed')

    case 'RESOLVE_DISPUTE':
      if (actor.role !== 'admin' && actor.role !== 'system') return deny(command.type, 'Only the authorized dispute-resolution backend can resolve a case.')
      if (tx.status !== 'disputed') return deny(command.type, 'Only a disputed transaction can be resolved.')
      if (!hasValidReference(command.resolutionReference)) return deny(command.type, 'A recorded resolution reference is required.')
      return allow(
        command.type,
        'The resolution can be submitted to the authoritative settlement workflow.',
        command.outcome === 'release' ? 'released' : 'cancelled',
      )

    case 'CANCEL':
      if (actor.role !== 'admin' && actor.role !== 'system') return deny(command.type, 'Cancellation that affects escrow requires the authorized backend.')
      if (!command.reason.trim()) return deny(command.type, 'A cancellation reason is required.')
      if (tx.status === 'released' || tx.status === 'cancelled' || tx.status === 'completed') {
        return deny(command.type, 'A terminal transaction cannot be cancelled or reopened.')
      }
      return allow(command.type, 'Cancellation can be submitted for server-side refund and inventory reconciliation.', 'cancelled')
  }
}
