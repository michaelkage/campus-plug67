export const TRANSACTION_STATUSES = [
  'pending',
  'locked',
  'meetup_initiated',
  'release_requested',
  'disputed',
  'released',
  'cancelled',
] as const

export type TransactionStatus = typeof TRANSACTION_STATUSES[number]
export type TransactionPayoutStatus = 'not_applicable' | 'pending' | 'approved_for_settlement' | 'processing' | 'paid' | 'failed' | string

export type TransactionLifecycleInput = {
  status?: string | null
  handshake_receipt_buffer?: string | null
  auto_release_at?: string | null
  escrow_status?: string | null
  payout_status?: TransactionPayoutStatus | null
  refund_status?: string | null
  payment_method?: string | null
}

export type TransactionLifecycle = {
  status: TransactionStatus | 'unknown'
  phase: 'payment' | 'protected' | 'meetup' | 'inspection' | 'seller_release_window' | 'dispute' | 'resolution' | 'cancelled' | 'unknown'
  title: string
  description: string
  tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success'
  handoffConfirmed: boolean
  inspectionDeadline: string | null
  payout: {
    status: string
    title: string
    description: string
    settled: boolean
  }
  canDispute: boolean
  terminal: boolean
}

const TERMINAL_STATUSES = new Set(['released', 'cancelled'])
const DISPUTABLE_STATUSES = new Set(['locked', 'meetup_initiated', 'release_requested'])

export function canOpenTransactionDispute(
  tx: TransactionLifecycleInput | null | undefined,
  now = Date.now(),
): boolean {
  if (!tx || !DISPUTABLE_STATUSES.has(tx.status ?? '')) return false
  if (tx.status !== 'release_requested' || !tx.auto_release_at) return true
  const deadline = new Date(tx.auto_release_at).getTime()
  return Number.isFinite(deadline) && deadline > now
}

function payoutPresentation(tx: TransactionLifecycleInput) {
  const status = tx.payout_status ?? 'not_applicable'
  if (status === 'paid') {
    return { status, title: 'Seller paid', description: 'The seller payout has been completed.', settled: true }
  }
  if (status === 'failed') {
    return { status, title: 'Payout needs attention', description: 'The transaction is resolved, but the payout failed and needs reconciliation.', settled: false }
  }
  if (status === 'processing' || status === 'approved_for_settlement') {
    return { status, title: 'Payout processing', description: 'The transaction is resolved. The payment provider is still processing the seller payout.', settled: false }
  }
  return { status, title: 'Settlement status unavailable', description: 'Check the latest server settlement record before treating the seller as paid.', settled: false }
}

export function deriveTransactionLifecycle(
  tx: TransactionLifecycleInput | null | undefined,
  now = Date.now(),
): TransactionLifecycle {
  const status = TRANSACTION_STATUSES.includes(tx?.status as TransactionStatus)
    ? tx!.status as TransactionStatus
    : 'unknown'
  const handoffConfirmed = Boolean(tx?.handshake_receipt_buffer)
  const inspectionDeadline = tx?.auto_release_at ?? null
  const payout = payoutPresentation(tx ?? {})

  const base: Pick<TransactionLifecycle, 'status' | 'handoffConfirmed' | 'inspectionDeadline' | 'payout' | 'canDispute' | 'terminal'> = {
    status,
    handoffConfirmed,
    inspectionDeadline,
    payout,
    canDispute: canOpenTransactionDispute(tx, now),
    terminal: TERMINAL_STATUSES.has(status),
  }

  switch (status) {
    case 'pending':
      return { ...base, phase: 'payment', title: 'Awaiting payment verification', description: 'The transaction is created. The purchase is not protected until payment is confirmed.', tone: 'warning' }
    case 'locked':
      return { ...base, phase: 'protected', title: 'Funds protected in escrow', description: 'Payment is confirmed and the funds remain locked while the parties arrange the handoff.', tone: 'info' }
    case 'meetup_initiated':
      return { ...base, phase: 'meetup', title: 'Meetup in progress', description: 'The seller has started the meetup. Complete the verified handoff before any payout can occur.', tone: 'info' }
    case 'release_requested':
      if (handoffConfirmed) {
        const expired = inspectionDeadline ? new Date(inspectionDeadline).getTime() <= now : false
        return {
          ...base,
          phase: 'inspection',
          title: expired ? 'Inspection window ended · settlement pending' : 'Handoff confirmed · inspection in progress',
          description: expired
            ? 'The inspection deadline has passed. The server settlement process must still confirm the payout.'
            : 'The QR handoff is recorded. Funds remain locked during the two-hour inspection window; either participant can open a dispute before it expires. QR confirmation is not a payout.',
          tone: expired ? 'warning' : 'info',
        }
      }
      return { ...base, phase: 'seller_release_window', title: 'Seller requested release', description: 'The seller requested release. Either participant may dispute during the configured window. If no dispute is filed, server settlement is triggered at the deadline; seller payout confirmation follows separately.', tone: 'warning' }
    case 'disputed':
      return { ...base, phase: 'dispute', title: 'Dispute under review', description: 'Automatic settlement is paused while the dispute is resolved. Funds remain protected pending the authoritative verdict.', tone: 'danger', canDispute: false }
    case 'released':
      return { ...base, phase: 'resolution', title: payout.settled ? 'Transaction settled' : 'Transaction resolved · payout pending', description: payout.settled ? 'The transaction has been resolved and seller settlement is recorded.' : 'The transaction resolution is recorded, but seller payout is not yet confirmed. Do not treat this as paid.', tone: payout.status === 'failed' ? 'warning' : payout.settled ? 'success' : 'warning' }
    case 'cancelled':
      return { ...base, phase: 'cancelled', title: 'Transaction cancelled', description: tx?.refund_status === 'processed' ? 'The buyer refund has been processed.' : 'The transaction is cancelled. Check the refund record for confirmation that money has returned to the buyer.', tone: 'neutral' }
    default:
      return { ...base, phase: 'unknown', title: 'Transaction status unavailable', description: 'The server status could not be mapped to a known transaction stage. No financial action should be inferred.', tone: 'neutral', canDispute: false, terminal: false }
  }
}
