import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20261125100000_campus_verification_evidence_retention.sql')
const orphanMigration = read('supabase/migrations/20261125110000_campus_verification_orphan_evidence_cleanup.sql')
const worker = read('supabase/functions/cleanup-campus-verification-evidence/index.ts')
const config = read('supabase/config.toml')
const docs = read('docs/campus-verification-fallback.md')
const validationWorkflow = read('.github/workflows/production-validation.yml')
const scheduledWorkflow = read('.github/workflows/campus-verification-evidence-retention.yml')

for (const invariant of [
  'ALTER COLUMN evidence_path DROP NOT NULL',
  "'expired'",
  'evidence_cleanup_attempts',
  'evidence_cleanup_next_attempt_at',
  'evidence_cleanup_claimed_at',
  'evidence_cleanup_last_error',
  'evidence_deleted_at',
  'FOR UPDATE SKIP LOCKED',
  "status = 'pending_review'",
  'evidence_expires_at <= now()',
  "SET status = 'expired'",
  "SET status = 'rejected'",
  "'evidence_expired'",
  "'evidence_deleted'",
  "'evidence_cleanup_failed'",
  "COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role'",
  "interval '10 minutes'",
  'evidence_cleanup_attempts < 8',
  'LEAST(1440',
  'REVOKE ALL ON FUNCTION public.claim_campus_verification_evidence_cleanup',
  'GRANT EXECUTE ON FUNCTION public.claim_campus_verification_evidence_cleanup(integer) TO service_role',
]) assert.ok(migration.includes(invariant), `Retention migration missing invariant: ${invariant}`)

assert.ok(worker.includes('isServiceRoleRequest(req)'))
assert.ok(worker.includes('admin.storage.from(BUCKET).remove([evidencePath])'))
assert.ok(worker.includes('removeIfPresent(admin, item.evidence_path)'))
assert.ok(worker.includes('campus_verification_evidence_object_exists'))
assert.ok(worker.includes('claim_campus_verification_evidence_cleanup'))
assert.ok(worker.includes('complete_campus_verification_evidence_cleanup'))
assert.ok(worker.includes('fail_campus_verification_evidence_cleanup'))
assert.ok(worker.includes('BATCH_SIZE = 50'))
assert.ok(worker.includes('claim_campus_verification_orphan_cleanup'))
assert.ok(worker.includes('complete_campus_verification_orphan_cleanup'))
assert.ok(worker.includes('fail_campus_verification_orphan_cleanup'))
assert.ok(worker.includes('orphan_discovered'))
assert.ok(worker.includes('orphan_deleted'))
assert.ok(worker.includes('failed === 0 ? 200 : 207'))
assert.ok(validationWorkflow.includes('feat/campus-membership-evidence-review'), 'Evidence-retention follow-ups must run full Supabase migration, pgTAP and Edge validation')
assert.ok(validationWorkflow.includes('supabase test db'), 'Full Supabase validation must execute pgTAP behavior tests')

for (const invariant of [
  'campus_verification_evidence_orphan_jobs',
  'campus_verification_evidence_object_exists',
  'FOR UPDATE OF o SKIP LOCKED',
  'ON CONFLICT (evidence_path) DO UPDATE',
  'cancelled_at IS NOT NULL',
  "interval '24 hours'",
  'campus_verification_evidence_submission_guard',
  'guard_campus_verification_evidence_submission',
  'REVOKE ALL ON FUNCTION public.guard_campus_verification_evidence_submission()',
  'claim_campus_verification_orphan_cleanup',
  'complete_campus_verification_orphan_cleanup',
  'fail_campus_verification_orphan_cleanup',
  "COALESCE(auth.jwt() ->> 'role', '') IS DISTINCT FROM 'service_role'",
  'name = NEW.evidence_path',
  'FOR UPDATE',
  'REVOKE ALL ON public.campus_verification_evidence_orphan_jobs',
]) assert.ok(orphanMigration.includes(invariant), `Orphan retention migration missing: ${invariant}`)

assert.ok(config.includes('[functions.cleanup-campus-verification-evidence]'))
assert.ok(config.includes('verify_jwt = false'))

for (const invariant of [
  'campus-verification-evidence-retention.yml',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'workflow_dispatch',
  'CAMPUS_EVIDENCE_RETENTION_ENABLED=true',
  'every 15 minutes',
  'No `pg_cron`, `pg_net`, Vault secret',
  'evidence_cleanup_attempts',
  'evidence_deleted_at',
  'expired',
  'maximum of eight attempts',
  '24-hour submission grace period',
  'abandoned, unreferenced uploads',
  'orphan jobs with',
  'campus_verification_evidence_orphan_jobs',
  'Request, decision and audit metadata remain available',
  'No migration has been applied',
]) assert.ok(docs.includes(invariant), `Retention runbook missing: ${invariant}`)

for (const invariant of [
  "cron: \"*/15 * * * *\"",
  "cancel-in-progress: false",
  "--max-time 240",
  "if: github.ref == 'refs/heads/main' && vars.CAMPUS_EVIDENCE_RETENTION_ENABLED == 'true'",
  'SUPABASE_URL: ${{ secrets.SUPABASE_URL }}',
  'SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}',
  '/functions/v1/cleanup-campus-verification-evidence',
  "jq -r '.failed // 0'",
  'exit 1',
]) assert.ok(scheduledWorkflow.includes(invariant), `Retention scheduler missing: ${invariant}`)

console.log('Campus verification evidence retention regression checks passed.')
