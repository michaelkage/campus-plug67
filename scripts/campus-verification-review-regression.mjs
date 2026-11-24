import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const migration = read('supabase/migrations/20261124170000_campus_membership_evidence_review.sql')
const auth = read('src/contexts/AuthContext.tsx')
const authPage = read('src/pages/Auth.jsx')
const applicant = read('src/components/settings/CampusVerificationPanel.jsx')
const reviewer = read('src/components/admin/CampusVerificationReview.jsx')
const admin = read('src/pages/AdminConsole.jsx')
const settings = read('src/pages/Settings.jsx')

for (const invariant of [
  'CREATE TABLE IF NOT EXISTS public.campus_verification_requests',
  'CREATE TABLE IF NOT EXISTS public.campus_verification_vouches',
  'CREATE TABLE IF NOT EXISTS public.campus_verification_audit',
  "VALUES (\n  'campus-verification-evidence',\n  'campus-verification-evidence',\n  false",
  "bucket_id = 'campus-verification-evidence'",
  "storage.foldername(name))[1] = auth.uid()::text",
  'public.is_platform_admin()',
  'public.submit_my_campus_verification',
  'public.vouch_for_campus_verification',
  'public.get_campus_verification_review_queue',
  'public.review_campus_verification_request',
  'evidence_expires_at',
  "status='pending_review'",
  "interval '30 days'",
  "interval '30 days'",
  "interval '30 days'",
  "interval '30 days'",
  "verification_method='manual_evidence_review'",
  'campus_verification_audit',
]) assert.ok(migration.includes(invariant), `Campus verification migration missing: ${invariant}`)

assert.ok(!migration.includes('GRANT INSERT ON public.campus_verification_requests TO authenticated'))
assert.ok(!migration.includes('GRANT UPDATE ON public.campus_verification_requests TO authenticated'))
assert.ok(!migration.includes('GRANT INSERT ON public.campus_verification_vouches TO authenticated'))

const signUp = auth.slice(auth.indexOf(' const signUp=async('), auth.indexOf(' const signIn=async('))
assert.ok(signUp.includes('supabase.auth.signUp'))
assert.ok(!signUp.includes('validateEduEmail'), 'Signup must not require an institutional email')
assert.ok(!signUp.includes('university:'), 'Signup must not trust or write a university identity')
assert.ok(!signUp.includes('matric_number:'), 'Signup must not store matric data in Auth metadata or profiles')

assert.ok(authPage.includes('you@example.com'))
assert.ok(authPage.includes('Campus membership is a separate step in Settings'))
assert.ok(!authPage.includes('UNIVERSITIES'))
assert.ok(!authPage.includes('setDepartment'))

for (const invariant of [
  "from('campus_verification_requests')",
  "from('campus-verification-evidence')",
  "submit_my_campus_verification",
  'crypto.randomUUID()',
  'MAX_FILE_BYTES',
  'vouch_for_campus_verification',
  'does not approve the membership',
]) assert.ok(applicant.includes(invariant), `Applicant campus workflow missing: ${invariant}`)
assert.ok(applicant.includes('from(\'campus-verification-evidence\')'))

for (const invariant of [
  'get_campus_verification_review_queue',
  'review_campus_verification_request',
  'createSignedUrl',
  'peer_vouches',
  'remove([request.evidence_path])',
]) assert.ok(reviewer.includes(invariant), `Reviewer workflow missing: ${invariant}`)
assert.ok(admin.includes('CampusVerificationReview'))
assert.ok(settings.includes('<CampusVerificationPanel />'))

console.log('Campus membership evidence review regression checks passed.')
