export type EscrowStatus = 'pending' | 'held' | 'released' | 'refunded'

export type EscrowPresentation = {
  label: string
  tone: 'amber' | 'cyan' | 'green' | 'red'
  terminal: boolean
}

const PRESENTATION: Record<EscrowStatus, EscrowPresentation> = {
  pending: { label: 'VERIFYING PAYMENT', tone: 'amber', terminal: false },
  held: { label: 'FUNDS LOCKED IN ESCROW', tone: 'cyan', terminal: false },
  released: { label: 'FUNDS RELEASED', tone: 'green', terminal: true },
  refunded: { label: 'REFUND PROCESSED', tone: 'red', terminal: true },
}

export function presentEscrowStatus(status: EscrowStatus): EscrowPresentation {
  return PRESENTATION[status]
}

export function canTransitionEscrow(from: EscrowStatus, to: EscrowStatus): boolean {
  if (from === to) return true
  if (from === 'pending') return to === 'held' || to === 'refunded'
  if (from === 'held') return to === 'released' || to === 'refunded'
  return false
}
