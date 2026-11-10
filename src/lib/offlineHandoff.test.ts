import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createOfflineHandoffTicket,
  createOfflineHandoffToken,
  hashOfflineHandoffToken,
  offlineHandoffCommitmentKey,
  offlineHandoffReceiptKey,
  verifyOfflineHandoffTicket,
  type OfflineHandoffCommitment,
} from './offlineHandoff'

const commitmentBase = {
  success: true as const,
  voucher_id: 'voucher-1',
  transaction_id: 'transaction-1',
  expires_at: '2026-11-10T10:10:00.000Z',
  buyer_id: 'buyer-1',
  seller_id: 'seller-1',
  amount: 250000,
  safe_zone_id: 'zone-1',
}

describe('offline handoff voucher', () => {
  beforeEach(() => {
    vi.setSystemTime(new Date('2026-11-10T10:00:00.000Z'))
  })

  it('generates an unguessable 256-bit token', () => {
    const first = createOfflineHandoffToken()
    const second = createOfflineHandoffToken()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(second).not.toBe(first)
  })

  it('verifies a seller QR against the buyer cached commitment', async () => {
    const token = createOfflineHandoffToken()
    const commitment: OfflineHandoffCommitment = {
      ...commitmentBase,
      token_hash: await hashOfflineHandoffToken(token),
    }
    const ticket = createOfflineHandoffTicket({
      voucher_id: commitment.voucher_id,
      transaction_id: commitment.transaction_id,
      expires_at: commitment.expires_at,
      buyer_id: commitment.buyer_id,
      seller_id: commitment.seller_id,
      amount: commitment.amount,
      safe_zone_id: commitment.safe_zone_id,
    }, token)

    await expect(verifyOfflineHandoffTicket(JSON.stringify(ticket), commitment)).resolves.toMatchObject({
      voucher_id: commitment.voucher_id,
      transaction_id: commitment.transaction_id,
    })
  })

  it('rejects modified QR payloads and mismatched transactions', async () => {
    const token = createOfflineHandoffToken()
    const commitment: OfflineHandoffCommitment = {
      ...commitmentBase,
      token_hash: await hashOfflineHandoffToken(token),
    }
    const ticket = createOfflineHandoffTicket({
      voucher_id: commitment.voucher_id,
      transaction_id: commitment.transaction_id,
      expires_at: commitment.expires_at,
      buyer_id: commitment.buyer_id,
      seller_id: commitment.seller_id,
      amount: commitment.amount,
      safe_zone_id: commitment.safe_zone_id,
    }, token)

    await expect(verifyOfflineHandoffTicket(JSON.stringify({ ...ticket, amount: 1 }), commitment)).rejects.toThrow(/does not match/)
    await expect(verifyOfflineHandoffTicket(JSON.stringify({ ...ticket, token: createOfflineHandoffToken() }), commitment)).rejects.toThrow(/cryptographic check/)
  })

  it('does not trust the device clock to authorize or reject an offline proof', async () => {
    const token = createOfflineHandoffToken()
    const commitment: OfflineHandoffCommitment = {
      ...commitmentBase,
      token_hash: await hashOfflineHandoffToken(token),
    }
    const ticket = createOfflineHandoffTicket({
      voucher_id: commitment.voucher_id,
      transaction_id: commitment.transaction_id,
      expires_at: commitment.expires_at,
      buyer_id: commitment.buyer_id,
      seller_id: commitment.seller_id,
      amount: commitment.amount,
      safe_zone_id: commitment.safe_zone_id,
    }, token)

    await expect(verifyOfflineHandoffTicket(JSON.stringify(ticket), commitment)).resolves.toMatchObject({ voucher_id: commitment.voucher_id })
    await expect(verifyOfflineHandoffTicket(JSON.stringify({ ...ticket, expires_at: '2026-11-11T10:00:00.000Z' }), commitment)).resolves.toMatchObject({ voucher_id: commitment.voucher_id })
    await expect(verifyOfflineHandoffTicket('not-json', commitment)).rejects.toThrow(/valid offline handoff QR/)
  })

  it('stores buyer commitments separately from queued receipts', () => {
    expect(offlineHandoffCommitmentKey('transaction-1')).not.toBe(offlineHandoffReceiptKey('transaction-1'))
    expect(offlineHandoffCommitmentKey('transaction-1')).toBe('offline-handoff-commitment:transaction-1')
    expect(offlineHandoffReceiptKey('transaction-1')).toBe('offline-handoff-receipt:transaction-1')
  })
})
