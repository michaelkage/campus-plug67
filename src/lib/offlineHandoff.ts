export type OfflineHandoffCommitment = {
  success: true
  voucher_id: string
  transaction_id: string
  token_hash: string
  expires_at: string
  buyer_id: string
  seller_id: string
  amount: number
  safe_zone_id: string
}

export type OfflineHandoffTicket = {
  v: 1
  voucher_id: string
  transaction_id: string
  token: string
  expires_at: string
  buyer_id: string
  seller_id: string
  amount: number
  safe_zone_id: string
}

const encoder = new TextEncoder()

// Keep long-lived verification material separate from the one-time proof outbox.
export const offlineHandoffCommitmentKey = (transactionId: string) => `offline-handoff-commitment:${transactionId}`
export const offlineHandoffReceiptKey = (transactionId: string) => `offline-handoff-receipt:${transactionId}`

export function createOfflineHandoffToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function hashOfflineHandoffToken(token: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    throw new Error('Invalid offline handoff token')
  }
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function createOfflineHandoffTicket(
  commitment: Omit<OfflineHandoffCommitment, 'success' | 'token_hash'>,
  token: string,
): OfflineHandoffTicket {
  return { v: 1, ...commitment, token }
}

export async function verifyOfflineHandoffTicket(
  raw: string,
  commitment: OfflineHandoffCommitment,
): Promise<OfflineHandoffTicket> {
  let ticket: unknown
  try {
    ticket = JSON.parse(raw)
  } catch {
    throw new Error('This is not a valid offline handoff QR')
  }
  if (!ticket || typeof ticket !== 'object') throw new Error('Invalid offline handoff QR')

  const value = ticket as Partial<OfflineHandoffTicket>
  if (value.v !== 1
    || value.voucher_id !== commitment.voucher_id
    || value.transaction_id !== commitment.transaction_id
    || value.buyer_id !== commitment.buyer_id
    || value.seller_id !== commitment.seller_id
    || value.safe_zone_id !== commitment.safe_zone_id
    || value.amount !== commitment.amount
    || typeof value.token !== 'string'
    || typeof value.expires_at !== 'string') {
    throw new Error('This QR does not match the prepared transaction handoff')
  }

  // Device clocks are user-controlled and may be badly skewed. This check is
  // intentionally cryptographic only; the server enforces voucher expiry when
  // the queued proof is synchronized. Never authorize settlement from this result.
  if (!Number.isFinite(Date.parse(value.expires_at)) || !Number.isFinite(Date.parse(commitment.expires_at))) {
    throw new Error('Offline handoff QR has an invalid expiry timestamp')
  }

  const actualHash = await hashOfflineHandoffToken(value.token)
  if (actualHash !== commitment.token_hash) {
    throw new Error('Offline handoff QR failed its cryptographic check')
  }

  return value as OfflineHandoffTicket
}
