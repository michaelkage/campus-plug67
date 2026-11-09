import fs from 'node:fs'

const read = (relativePath) =>
  fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

function fail(message) {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}

function mustContain(source, value, message) {
  if (!source.includes(value)) fail(message)
}

const migration = read('supabase/migrations/20261109230000_add_offline_escrow_vouchers.sql')
const edge = read('supabase/functions/offline-escrow/index.ts')
const config = read('supabase/config.toml')

mustContain(migration, 'vault.create_secret', 'Offline signing private keys must be stored in Supabase Vault')
mustContain(migration, 'vault.decrypted_secrets', 'Only the service-role key loader may retrieve the Vault secret')
mustContain(migration, 'ALTER TABLE public.escrow_offline_vouchers ENABLE ROW LEVEL SECURITY', 'Voucher records must have RLS enabled')
mustContain(migration, 'ALTER TABLE public.escrow_offline_receipts ENABLE ROW LEVEL SECURITY', 'Receipt records must have RLS enabled')
mustContain(migration, 'REVOKE ALL ON FUNCTION public.reconcile_offline_escrow_receipt', 'Receipt reconciliation RPC must not be callable by client roles')
mustContain(migration, 'UNIQUE', 'Offline voucher and receipt nonces must be unique')
mustContain(migration, "status = 'release_requested'", 'Reconciled receipts must enter the inspection-buffer state')
mustContain(migration, "interval '2 hours'", 'Offline receipt sync must start a two-hour inspection window')
mustContain(migration, 'revoke_issued_offline_escrow_vouchers_on_state_change', 'State changes must revoke outstanding offline vouchers')
mustContain(migration, "interval '30 minutes'", 'Offline vouchers must have a short validity window')
mustContain(migration, "interval '6 hours'", 'Offline receipts must have a bounded sync grace period')

mustContain(edge, 'crypto.subtle.generateKey', 'Voucher signing keys must use an asymmetric Ed25519 keypair')
mustContain(edge, 'crypto.subtle.sign({ name: "Ed25519" }', 'Voucher claims must be signed server-side')
mustContain(edge, 'crypto.subtle.verify(', 'Voucher signatures must be verified before reconciliation')
mustContain(edge, 'verifyAuthenticationResponse', 'Offline receipts must be verified with the seller passkey')
mustContain(edge, 'expectedChallenge: challenge', 'Seller passkey assertions must bind to the receipt payload')
mustContain(edge, 'reconcile_offline_escrow_receipt', 'Verified receipts must reconcile through the atomic database RPC')
mustContain(edge, 'funds_released: false', 'Offline QR handoff must remain provisional and never settle funds locally')
mustContain(edge, 'seller_credentials', 'Voucher claims must bind the receipt to a registered seller passkey')

mustContain(config, '[functions.offline-escrow]', 'Offline escrow Edge Function must be configured')
mustContain(config, 'verify_jwt = false', 'Offline escrow must use explicit manual JWT validation for public ping/key routes')

if (process.exitCode) process.exit(process.exitCode)
console.log('Offline escrow voucher regression checks passed')
