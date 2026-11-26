import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20261126140000_admin_financial_operations_snapshot.sql')
const admin = read('src/pages/AdminConsole.jsx')
const docs = read('docs/admin-financial-operations.md')
const databaseTest = read('supabase/tests/admin_financial_operations.test.sql')

for (const required of [
  'CREATE OR REPLACE FUNCTION public.get_admin_financial_operations_snapshot',
  'IF NOT public.is_platform_admin()',
  'v_limit < 1 OR v_limit > 100',
  "t.refund_status IN ('failed','needs-attention','needs_attention')",
  "p.processing_status = 'failed'",
  "'paystack-escrow-funded:' || t.id::text",
  "'paystack-escrow-released:' || t.id::text",
  "'paystack-escrow-refunded:' || t.id::text",
  "'plug-credit-ledger:' || f.reference_id::text",
  'public.financial_journal_trial_balance',
  'journal_balance_imbalances',
  'payout_attention',
  'stale_payout_attempts',
  'payout_operator_audits',
  "p.status IN ('needs_attention','blocked','rejected','abandoned','reversed')",
  "p.status IN ('processing','pending')",
  "'paystack-payout:' || p.reference || ':success'",
  "'paystack-payout:' || p.reference || ':reversed'",
  'public.seller_payout_operator_audit',
  'provider_http_status',
  'last_reconciled_at',
  'lease_expires_at',
  'refund_attention',
  'payment_failures',
  'missing_journal',
  'unmirrored_wallet_entries',
  'REVOKE ALL ON FUNCTION public.get_admin_financial_operations_snapshot(integer)',
  'GRANT EXECUTE ON FUNCTION public.get_admin_financial_operations_snapshot(integer)',
]) assert.ok(migration.includes(required), `Financial operations migration missing: ${required}`)

assert.equal(
  (migration.match(/paystack_payout_reversal_success_not_posted/g) || []).length,
  1,
  'Reversed payout success-posting exceptions must not be duplicated',
)
assert.match(
  migration,
  /GREATEST\(p\.updated_at, COALESCE\(p\.last_reconciled_at,p\.created_at\)\) <= now\(\) - interval '15 minutes'[\s\S]*?p\.lease_expires_at IS NULL OR p\.lease_expires_at <= now\(\)/,
  'Stale payout detection must respect the last reconciliation time and active lease',
)
assert.match(
  migration,
  /seller_payout_transfers_attention_idx[\s\S]*?'reversed'/,
  'Reversed payouts must be included in the attention index',
)

const functionBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.get_admin_financial_operations_snapshot'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.get_admin_financial_operations_snapshot'),
)
assert.ok(!/\b(INSERT INTO|UPDATE public\.|DELETE FROM)\b/i.test(functionBody), 'Financial operations snapshot must remain read-only')

for (const required of [
  "['financial-ops','Financial ops',Banknote]",
  "tab==='financial-ops'",
  "get_admin_financial_operations_snapshot",
  'Refunds needing attention',
  'Failed provider events',
  'Missing journal postings',
  'Unmirrored wallet entries',
  'Trial balance integrity',
  'Payouts requiring attention',
  'Stale payout attempts',
  'Manual payout recovery audit',
  'Append-only operator decisions',
  'Nothing here moves money.',
]) assert.ok(admin.includes(required), `Admin Console financial operations UI missing: ${required}`)

for (const required of [
  'Read-only by design',
  'refund attention',
  'missing journal',
  '15 minutes',
  'does not retry refunds',
  'does not initiate payouts',
  'no migration has been applied',
  'seller payout',
  'provider 404',
  'append-only operator recovery audit',
]) assert.ok(docs.toLowerCase().includes(required.toLowerCase()), `Financial operations runbook missing: ${required}`)

for (const required of [
  'SELECT plan(9)',
  'get_admin_financial_operations_snapshot',
  'Platform admin required',
  "has_function_privilege('anon'",
  "has_function_privilege('authenticated'",
  'cp_tr_admin_attention_001',
  'cp_tr_admin_stale_001',
  'stale_payouts',
]) assert.ok(databaseTest.includes(required), `Financial operations database test missing: ${required}`)

console.log('Admin financial operations regression checks passed.')

