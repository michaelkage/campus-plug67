import { startAuthentication } from '@simplewebauthn/browser'
import { supabase } from './supabase'
import {
  getLocalTransaction,
  listActiveLocalTransactions,
  removeLocalTransaction,
  saveLocalTransaction,
} from './transactionState'

export type OfflineSellerCredential = { id: string; transports: string[] }
export type OfflineVoucherClaims = {
  v: 1
  kid: string
  jti: string
  transaction_id: string
  buyer_id: string
  seller_id: string
  payment_method: 'campus_wallet' | 'paystack'
  amount_kobo: number
  safe_zone_id: string
  rp_id: string
  seller_credentials: OfflineSellerCredential[]
  nonce: string
  issued_at: string
  expires_at: string
  sync_grace_until: string
}
export type OfflineReceiptCore = {
  v: 1
  voucher_id: string
  transaction_id: string
  buyer_id: string
  seller_id: string
  nonce: string
  voucher_hash: string
  receipt_nonce: string
  scanned_at: string
  qr_counter: number
  qr_code: string
}
export type OfflineReceipt = {
  core: OfflineReceiptCore
  assertion: Awaited<ReturnType<typeof startAuthentication>>
}
export type IssuedOfflineVoucher = {
  voucher_token: string
  claims: OfflineVoucherClaims
  public_key: string
  algorithm: 'Ed25519'
  server_status: 'funds_locked_provisional'
}
type CachedPublicKey = { key_id: string; public_key: string; algorithm: 'Ed25519' }
type StoredReceipt = { voucher_token: string; receipt: OfflineReceipt }
const PUBLIC_KEY_CACHE = 'campus-plug:offline-escrow-public-key:v1'
const RECEIPT_PREFIX = 'offline-escrow-receipt:'
const VOUCHER_PREFIX = 'offline-escrow-voucher:'
const QR_STEP_MS = 30_000
const encoder = new TextEncoder()

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}
function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return '{' + Object.keys(object).sort().map(key =>
      JSON.stringify(key) + ':' + canonicalJson(object[key]),
    ).join(',') + '}'
  }
  return JSON.stringify(value)
}
async function sha256(value: string | Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof value === 'string' ? encoder.encode(value) : value))
}
async function sha256Hex(value: string | Uint8Array): Promise<string> {
  return Array.from(await sha256(value), byte => byte.toString(16).padStart(2, '0')).join('')
}
function randomBase64Url(length = 32): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(length)))
}
function readCachedPublicKey(): CachedPublicKey | null {
  try {
    const raw = localStorage.getItem(PUBLIC_KEY_CACHE)
    if (!raw) return null
    const value = JSON.parse(raw) as CachedPublicKey
    return value.algorithm === 'Ed25519' && value.key_id && value.public_key ? value : null
  } catch {
    return null
  }
}
function cachePublicKey(value: CachedPublicKey) {
  localStorage.setItem(PUBLIC_KEY_CACHE, JSON.stringify(value))
}

export async function refreshOfflineEscrowPublicKey(): Promise<CachedPublicKey> {
  const { data, error } = await supabase.functions.invoke('offline-escrow/public-key', { method: 'GET' })
  if (error) throw error
  if (!data?.key_id || !data?.public_key || data?.algorithm !== 'Ed25519') {
    throw new Error('Offline verification key is unavailable')
  }
  const key = { key_id: data.key_id as string, public_key: data.public_key as string, algorithm: 'Ed25519' as const }
  cachePublicKey(key)
  return key
}

async function getOfflineEscrowPublicKey(): Promise<CachedPublicKey> {
  const cached = readCachedPublicKey()
  if (navigator.onLine) {
    try {
      return await refreshOfflineEscrowPublicKey()
    } catch (error) {
      if (!cached) throw error
    }
  }
  if (!cached) throw new Error('Connect once before the meetup to cache the offline voucher verification key.')
  return cached
}

export async function issueOfflineVoucher(transactionId: string, ownerId: string): Promise<IssuedOfflineVoucher> {
  const { data, error } = await supabase.functions.invoke('offline-escrow', {
    body: { action: 'issue_voucher', transaction_id: transactionId },
  })
  if (error) throw error
  if (!data?.success || !data.voucher_token || !data.claims || !data.public_key) {
    throw new Error(data?.error || 'Unable to prepare offline handoff')
  }
  cachePublicKey({ key_id: data.claims.kid, public_key: data.public_key, algorithm: 'Ed25519' })
  const voucher = data as IssuedOfflineVoucher
  await saveLocalTransaction({
    id: VOUCHER_PREFIX + transactionId,
    ownerId,
    kind: 'offline-escrow-voucher',
    payload: voucher,
    status: 'queued',
    updatedAt: Date.now(),
  })
  return voucher
}

export async function loadOfflineVoucher(transactionId: string, ownerId: string): Promise<IssuedOfflineVoucher | null> {
  const local = await getLocalTransaction(VOUCHER_PREFIX + transactionId).catch(() => undefined)
  if (!local || local.ownerId !== ownerId || local.kind !== 'offline-escrow-voucher') return null
  const voucher = local.payload as IssuedOfflineVoucher
  if (!voucher?.voucher_token || !voucher.claims?.expires_at) return null
  return Date.parse(voucher.claims.expires_at) > Date.now() ? voucher : null
}

export async function makeRotatingOfflineQr(voucher: IssuedOfflineVoucher, now = Date.now()): Promise<string> {
  const counter = Math.floor(now / QR_STEP_MS)
  const code = await sha256Hex(`${voucher.claims.nonce}:${counter}`)
  return `CPQ1.${voucher.voucher_token}.${counter}.${code}`
}

export async function verifyOfflineQr(rawValue: string, sellerId: string) {
  const parts = rawValue.trim().split('.')
  if (parts.length !== 6 || parts[0] !== 'CPQ1' || parts[1] !== 'CPV1') {
    throw new Error('This is not a Campus Plug rotating offline QR')
  }
  const voucherToken = parts.slice(1, 4).join('.')
  const payloadBytes = decodeBase64Url(parts[2])
  const signature = decodeBase64Url(parts[3])
  const counter = Number(parts[4])
  const code = parts[5]
  if (!Number.isSafeInteger(counter) || !/^[0-9a-f]{64}$/.test(code)) {
    throw new Error('The rotating QR is malformed')
  }

  const claims = JSON.parse(new TextDecoder().decode(payloadBytes)) as OfflineVoucherClaims
  const cached = await getOfflineEscrowPublicKey()
  if (claims.kid !== cached.key_id || claims.seller_id !== sellerId || claims.v !== 1) {
    throw new Error('This voucher is not issued for your account or signing key')
  }
  const publicKey = await crypto.subtle.importKey(
    'raw',
    decodeBase64Url(cached.public_key),
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  const valid = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, payloadBytes)
  if (!valid) throw new Error('Offline voucher signature is invalid')

  const issuedAt = Date.parse(claims.issued_at)
  const expiresAt = Date.parse(claims.expires_at)
  const currentCounter = Math.floor(Date.now() / QR_STEP_MS)
  const expectedCode = await sha256Hex(`${claims.nonce}:${counter}`)
  const counterTime = counter * QR_STEP_MS
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)
    || Date.now() < issuedAt - 5 * 60_000 || Date.now() > expiresAt
    || Math.abs(currentCounter - counter) > 1
    || counterTime < issuedAt - QR_STEP_MS || counterTime > expiresAt + QR_STEP_MS
    || expectedCode !== code) {
    throw new Error('Rotating QR is expired or stale. Ask the buyer to refresh it.')
  }
  return { voucherToken, claims, counter, code }
}

export async function createOfflineReceipt(rawValue: string, sellerId: string): Promise<StoredReceipt> {
  const verified = await verifyOfflineQr(rawValue, sellerId)
  const voucherHash = await sha256Hex(verified.voucherToken)
  const core: OfflineReceiptCore = {
    v: 1,
    voucher_id: verified.claims.jti,
    transaction_id: verified.claims.transaction_id,
    buyer_id: verified.claims.buyer_id,
    seller_id: verified.claims.seller_id,
    nonce: verified.claims.nonce,
    voucher_hash: voucherHash,
    receipt_nonce: randomBase64Url(32),
    scanned_at: new Date().toISOString(),
    qr_counter: verified.counter,
    qr_code: verified.code,
  }
  const challenge = encodeBase64Url(await sha256(encoder.encode(canonicalJson(core))))
  const assertion = await startAuthentication({
    challenge,
    rpId: verified.claims.rp_id,
    timeout: 60_000,
    allowCredentials: verified.claims.seller_credentials.map(credential => ({
      id: credential.id,
      type: 'public-key' as const,
      transports: credential.transports as never,
    })),
    userVerification: 'required',
  })
  const receipt = { core, assertion }
  return { voucher_token: verified.voucherToken, receipt }
}

export async function saveOfflineEscrowReceipt(ownerId: string, stored: StoredReceipt) {
  await saveLocalTransaction({
    id: RECEIPT_PREFIX + stored.receipt.core.voucher_id,
    ownerId,
    kind: 'offline-escrow-receipt',
    payload: stored,
    status: 'queued',
    updatedAt: Date.now(),
  })
}

export async function syncOfflineEscrowReceipt(stored: StoredReceipt) {
  const { data, error } = await supabase.functions.invoke('offline-escrow', {
    body: {
      action: 'reconcile_receipt',
      voucher_token: stored.voucher_token,
      receipt: stored.receipt,
    },
  })
  if (error) throw error
  if (!data?.success) throw new Error(data?.error || 'Offline receipt synchronization failed')
  await removeLocalTransaction(RECEIPT_PREFIX + stored.receipt.core.voucher_id)
  return data
}

export async function syncPendingOfflineEscrowReceipts(ownerId: string) {
  const pending = await listActiveLocalTransactions(ownerId)
  const receipts = pending.filter(item => item.kind === 'offline-escrow-receipt')
  const results: Array<{ id: string; success: boolean; error?: string }> = []
  for (const item of receipts) {
    try {
      await syncOfflineEscrowReceipt(item.payload as StoredReceipt)
      results.push({ id: item.id, success: true })
    } catch (error) {
      results.push({ id: item.id, success: false, error: error instanceof Error ? error.message : 'Sync failed' })
    }
  }
  return results
}
