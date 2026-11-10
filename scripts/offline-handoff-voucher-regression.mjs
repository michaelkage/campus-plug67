import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20261110103000_offline_handoff_vouchers.sql')
const helper = read('src/lib/offlineHandoff.ts')
const test = read('src/lib/offlineHandoff.test.ts')

const requiredMigrationInvariants = [
  'CREATE TABLE IF NOT EXISTS public.offline_handoff_vouchers',
  'token_hash text NOT NULL',
  'ALTER TABLE public.offline_handoff_vouchers ENABLE ROW LEVEL SECURITY',
  'REVOKE ALL ON TABLE public.offline_handoff_vouchers FROM PUBLIC, anon, authenticated',
  'CREATE OR REPLACE FUNCTION public.prepare_offline_handoff',
  'CREATE OR REPLACE FUNCTION public.get_offline_handoff_commitment',
  'CREATE OR REPLACE FUNCTION public.confirm_offline_handoff',
  "now() + interval '10 minutes'",
  "now() + interval '2 hours'",
  "extensions.digest(convert_to(p_token, 'UTF8'), 'sha256')",
  "v_actor <> v_tx.seller_id",
  "v_actor <> v_actor",
  "v_actor <> v_voucher.buyer_id",
  "v_tx.status <> 'meetup_initiated'",
  "handshake_receipt_buffer = now()",
  "'funds_released', false",
]
for (const invariant of requiredMigrationInvariants) {
  if (!migration.includes(invariant)) throw new Error(`Missing offline voucher SQL invariant: ${invariant}`)
}
if (migration.includes('token text NOT NULL')) throw new Error('The database must never store the plaintext handoff token')
if (!helper.includes("crypto.subtle.digest('SHA-256'")) throw new Error('Client must verify voucher commitments with SHA-256')
if (!helper.includes('crypto.getRandomValues')) throw new Error('Offline voucher tokens must use cryptographically secure randomness')
for (const invariant of ['mismatched transactions', 'expired vouchers', 'cryptographic check']) {
  if (!test.includes(invariant)) throw new Error(`Missing offline handoff test case: ${invariant}`)
}
console.log('Offline handoff voucher security regression checks passed.')
