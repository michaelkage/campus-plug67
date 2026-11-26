BEGIN;
SELECT plan(14);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  'f7100000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'retention-applicant@test.invalid', '',
  now(), '{}'::jsonb, '{"full_name":"Retention Applicant"}'::jsonb, now(), now()
);

INSERT INTO public.institutions(id, name, slug, is_active)
VALUES (
  'f7200000-0000-4000-8000-000000000001',
  'Evidence Retention Test Campus',
  'evidence-retention-test-campus',
  true
);

INSERT INTO storage.objects(bucket_id, name, owner, owner_id, metadata)
VALUES (
  'campus-verification-evidence',
  'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-000000000001/f7300000-0000-4000-8000-000000000001.jpg',
  'f7100000-0000-4000-8000-000000000001',
  'f7100000-0000-4000-8000-000000000001',
  '{"mimetype":"image/jpeg"}'::jsonb
);

INSERT INTO public.institution_memberships(user_id, institution_id, status, verification_method)
VALUES (
  'f7100000-0000-4000-8000-000000000001',
  'f7200000-0000-4000-8000-000000000001',
  'pending',
  'manual_evidence_review'
);

INSERT INTO public.campus_verification_requests(
  id, user_id, institution_id, matric_number, evidence_path,
  evidence_mime_type, status, submitted_at, evidence_expires_at
) VALUES (
  'f7300000-0000-4000-8000-000000000002',
  'f7100000-0000-4000-8000-000000000001',
  'f7200000-0000-4000-8000-000000000001',
  'RET/2026/001',
  'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-000000000001/f7300000-0000-4000-8000-000000000001.jpg',
  'image/jpeg',
  'pending_review',
  now() - interval '31 days',
  now() - interval '1 day'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

CREATE TEMP TABLE retention_claim AS
SELECT public.claim_campus_verification_evidence_cleanup(10) AS result;

SELECT is((SELECT (result->>'expired_requests')::integer FROM retention_claim), 1, 'Expired pending requests are moved to expired state');
SELECT is((SELECT (result->>'claimed_count')::integer FROM retention_claim), 1, 'Expired evidence is claimed for cleanup');
SELECT is((SELECT status FROM public.campus_verification_requests WHERE id = 'f7300000-0000-4000-8000-000000000002'), 'expired', 'Expiry never grants verified membership');
SELECT is((SELECT status FROM public.institution_memberships WHERE user_id = 'f7100000-0000-4000-8000-000000000001' AND institution_id = 'f7200000-0000-4000-8000-000000000001'), 'rejected', 'Expired request closes its pending membership');
SELECT is((SELECT count(*)::integer FROM public.campus_verification_audit WHERE request_id = 'f7300000-0000-4000-8000-000000000002' AND action = 'evidence_expired'), 1, 'Expiry is recorded in the audit trail');

SELECT is(
  public.complete_campus_verification_evidence_cleanup(
    'f7300000-0000-4000-8000-000000000002',
    'f7100000-0000-4000-8000-000000000001/f7200000-0000-4000-8000-000000000001/f7300000-0000-4000-8000-000000000001.jpg'
  ),
  true,
  'Worker-reported Storage API deletion is finalized'
);
SELECT is((SELECT evidence_path IS NULL FROM public.campus_verification_requests WHERE id = 'f7300000-0000-4000-8000-000000000002'), true, 'Deleted evidence path is cleared from the request');
SELECT ok((SELECT evidence_deleted_at IS NOT NULL FROM public.campus_verification_requests WHERE id = 'f7300000-0000-4000-8000-000000000002'), 'Deletion timestamp is persisted');
SELECT is((SELECT count(*)::integer FROM public.campus_verification_audit WHERE request_id = 'f7300000-0000-4000-8000-000000000002' AND action = 'evidence_deleted'), 1, 'Successful deletion is audited');
SELECT throws_ok(
  $audit$ UPDATE public.campus_verification_audit SET metadata = '{}'::jsonb WHERE request_id = 'f7300000-0000-4000-8000-000000000002' $audit$,
  'P0001',
  'Campus verification audit is append-only',
  'Campus verification audit history cannot be rewritten'
);
SELECT is(has_table_privilege('service_role', 'public.campus_verification_audit', 'UPDATE'), false, 'Service role cannot update campus verification audit rows');
SELECT is(has_table_privilege('service_role', 'public.campus_verification_audit', 'INSERT'), true, 'Service role can append cleanup audit rows');
SELECT is(has_table_privilege('service_role', 'public.campus_verification_audit', 'DELETE'), false, 'Service role cannot delete campus verification audit rows');
SELECT is(has_function_privilege('authenticated', 'public.claim_campus_verification_evidence_cleanup(integer)', 'EXECUTE'), false, 'Authenticated users cannot claim evidence cleanup work');

SELECT * FROM finish();
ROLLBACK;
