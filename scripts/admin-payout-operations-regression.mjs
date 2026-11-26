import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20261126100000_admin_payout_operator_audit.sql')
const snapshot = read('supabase/migrations/20261126110000_admin_payout_reconciliation_snapshot.sql')
const edge = read('supabase/functions/admin-resolve-paystack-payout-attention/index.ts')
const panel = read('src/components/admin/PayoutReconciliationPanel.jsx')
const admin = read('src/pages/AdminConsole.jsx')
const config = read('supabase/config.toml')
const docs = read('docs/payments/PAYSTACK_SELLER_PAYOUT_OPERATIONS.md')
const packageJson = JSON.parse(read('package.json'))
const scheduledWorkflow = read('.github/workflows/seller-payout-reconciliation.yml')
const paymentWorkflow = read('.github/workflows/payment-reconciliation.yml')
const legacyRecovery = read('supabase/functions/resolve-paystack-payout-attention/index.ts')

for (const invariant of [
  'CREATE TABLE IF NOT EXISTS public.seller_payout_operator_audit',
  'operator_id uuid NOT NULL',
  'action text NOT NULL',
  'before_status text NOT NULL',
  'after_status text NOT NULL',
  'provider_http_status integer',
  'provider_verified_at timestamptz NOT NULL',
  'seller_payout_operator_audit_immutable',
  'BEFORE UPDATE OR DELETE',
  'REVOKE ALL ON public.seller_payout_operator_audit FROM PUBLIC, anon, authenticated, service_role',
  'write_seller_payout_operator_audit',
  'record_paystack_transfer_with_operator_audit',
  'confirm_paystack_transfer_not_created_with_operator_audit',
  'public.record_paystack_transfer(',
  'public.confirm_paystack_transfer_not_created(',
  'INSERT INTO public.seller_payout_operator_audit',
  'GRANT EXECUTE ON FUNCTION public.confirm_paystack_transfer_not_created_with_operator_audit',
  'p_provider_http_status IS NULL',
]) assert.ok(migration.includes(invariant), `Operator audit migration missing invariant: ${invariant}`)

const recordWrapper = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.record_paystack_transfer_with_operator_audit'),
  migration.indexOf('CREATE OR REPLACE FUNCTION public.confirm_paystack_transfer_not_created_with_operator_audit'),
)
assert.ok(recordWrapper.indexOf('public.record_paystack_transfer(') < recordWrapper.indexOf('INSERT INTO public.seller_payout_operator_audit'))
assert.ok(recordWrapper.includes('v_transfer.status, v_after.status'))

const confirmWrapper = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.confirm_paystack_transfer_not_created_with_operator_audit'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.write_seller_payout_operator_audit'),
)
assert.ok(confirmWrapper.indexOf('public.confirm_paystack_transfer_not_created(') < confirmWrapper.indexOf('INSERT INTO public.seller_payout_operator_audit'))
assert.ok(confirmWrapper.includes("'confirm_not_created'"))

for (const invariant of [
  'public.is_platform_admin()',
  "'payout_attention'",
  "'payout_inflight'",
  "'payout_reversals_24h'",
  "'payout_queue'",
  "'payout_operator_audit'",
  'public.seller_payout_transfers',
  'public.seller_payout_operator_audit',
]) assert.ok(snapshot.includes(invariant), `Admin payout snapshot missing: ${invariant}`)

for (const invariant of [
  'getAuthenticatedUser(req)',
  'createUserClient(token)',
  'userClient.rpc("is_platform_admin")',
  'userClient.rpc("consume_rate_limit",',
  'p_operator_id: user.id',
  '/transfer/verify/',
  'confirm_paystack_transfer_not_created_with_operator_audit',
  'record_paystack_transfer_with_operator_audit',
  'write_seller_payout_operator_audit',
  'p_action: "recovery_rejected"',
  'Number.isSafeInteger(actualAmount)',
  'actualAmount === Number(transfer.amount_kobo)',
  'actualRecipient === recipient.recipient_code',
  'response.status === 404',
  'validNote(note)',
  'body?.dashboard_attested !== true',
]) assert.ok(edge.includes(invariant), `Admin payout Edge Function missing: ${invariant}`)

assert.ok(!edge.includes('"/transfer"'), 'Admin operator endpoint must never create a transfer')
assert.ok(!edge.includes('body?.operator_id'), 'Operator identity must never come from client request data')
assert.ok(!edge.includes('p_amount: actualAmount'), 'Provider mismatch amount must not be passed to the financial recorder')
assert.ok(legacyRecovery.includes('status: 410'), 'Unaudited legacy recovery endpoint must be retired')
assert.ok(!legacyRecovery.includes('confirm_paystack_transfer_not_created'), 'Legacy endpoint must not mutate payout retry state')
assert.ok(scheduledWorkflow.includes('/functions/v1/process-paystack-payouts'))
assert.ok(scheduledWorkflow.includes('/functions/v1/reconcile-paystack-transfers'))
assert.ok(scheduledWorkflow.indexOf('/functions/v1/process-paystack-payouts') < scheduledWorkflow.indexOf('/functions/v1/reconcile-paystack-transfers'))
assert.ok(scheduledWorkflow.includes("if: github.ref == 'refs/heads/main'"), 'Financial automation must only run from the protected default branch')
assert.ok(scheduledWorkflow.includes("cron: \"*/10 * * * *\""))
assert.ok(!paymentWorkflow.includes('/functions/v1/process-paystack-payouts'), 'Payouts must use the dedicated scheduler, not duplicate payment/refund workflow')

for (const invariant of [
  'admin-resolve-paystack-payout-attention',
  'Verify with Paystack',
  'Confirm no transfer exists',
  'confirm_not_created',
  'confirmations[row.reference]',
  'dashboard_attested: action === \'confirm_not_created\' && confirmations[reference] === true',
  '20 and 500 characters',
  'support_ticket',
  'Recent payout operator audit',
  'Append-only history',
  'No payout state changed',
]) assert.ok(panel.includes(invariant), `Payout operator UI missing: ${invariant}`)

assert.ok(admin.includes('PayoutReconciliationPanel'))
assert.ok(config.includes('[functions.process-paystack-payouts]\nverify_jwt = false'))
assert.ok(config.includes('[functions.reconcile-paystack-transfers]\nverify_jwt = false'))
assert.ok(config.includes('[functions.resolve-paystack-payout-attention]\nverify_jwt = false'))
assert.ok(!config.includes('[functions.admin-resolve-paystack-payout-attention]\nverify_jwt = false'), 'Admin operator endpoint must retain platform JWT verification')

for (const invariant of [
  'seller_payout_operator_audit',
  'admin-resolve-paystack-payout-attention',
  'provider 404',
  '30-minute',
  'append-only',
  'operator ID is derived from the verified JWT',
  'Neither action can create or submit a transfer',
]) assert.ok(docs.includes(invariant), `Payout operations runbook missing: ${invariant}`)

for (const test of [
  'scripts/paystack-payout-lifecycle-regression.mjs',
  'scripts/refund-payout-serialization-regression.mjs',
  'scripts/financial-payout-journal-trigger-regression.mjs',
  'scripts/admin-payout-operations-regression.mjs',
]) assert.ok(packageJson.scripts['test:platform-integrity'].includes(test), `Platform integrity suite missing ${test}`)

console.log('Admin payout reconciliation and operator audit regression checks passed.')
