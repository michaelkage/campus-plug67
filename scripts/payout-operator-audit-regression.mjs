import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20261126131000_audit_paystack_payout_manual_recovery.sql')
const recovery = read('supabase/functions/resolve-paystack-payout-attention/index.ts')
const dispute = read('supabase/functions/process-dispute/index.ts')

for (const required of [
  'seller_payout_operator_audit',
  'operator_id uuid NOT NULL REFERENCES auth.users(id)',
  "action IN ('confirmed_not_created')",
  'provider_http_status integer NOT NULL CHECK (provider_http_status = 404)',
  'BEFORE UPDATE OR DELETE ON public.seller_payout_operator_audit',
  'DROP FUNCTION IF EXISTS public.confirm_paystack_transfer_not_created(text,text)',
  'p_operator_id uuid',
  "v_tx.payout_status IS DISTINCT FROM 'needs_attention'",
  'FOR UPDATE',
  'audit_recorded',
  'GRANT EXECUTE ON FUNCTION public.confirm_paystack_transfer_not_created(text,text,uuid)',
 ]) assert.ok(migration.includes(required), `Payout audit migration missing: ${required}`)
assert.ok(/GRANT EXECUTE ON FUNCTION public\.confirm_paystack_transfer_not_created\(text,text,uuid\)\s+TO service_role;/.test(migration), 'Service-role execution grant must be present')

for (const required of [
  'SUPABASE_ANON_KEY',
  'admin.auth.getUser(bearer)',
  'operatorClient.rpc("is_platform_admin")',
  'Platform admin permission required',
  'p_operator_id: operator.id',
  'response.status !== 404',
  'confirm_not_created !== true',
]) assert.ok(recovery.includes(required), `Payout recovery operator guard missing: ${required}`)

assert.ok(!recovery.includes('isServiceRoleRequest(req)) return jsonResponse({ error: "Forbidden"'), 'Manual recovery must not be service-role-only')
assert.ok(dispute.includes('enqueue_plugscore_event'), 'Payout branch must preserve M13 idempotent jury rewards')
assert.ok(!/profiles\\"?\.?from\(\\"profiles\\"\)\.update\(\{\s*plug_score/.test(dispute), 'Dispute worker must not directly mutate PlugScore')

console.log('Payout operator audit regression checks passed.')
