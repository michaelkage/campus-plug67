BEGIN;
SELECT plan(3);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  'f7100000-0000-4000-8000-000000000001',
  'authenticated',
  'authenticated',
  'trust-scan-seller@test.invalid',
  '',
  now(),
  '{}'::jsonb,
  '{"full_name":"Trust Scan Seller"}'::jsonb,
  now(),
  now()
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'f7100000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', '{"sub":"f7100000-0000-4000-8000-000000000001","role":"authenticated"}', true);

INSERT INTO public.listings (
  id, seller_id, title, description, category, price, status, university,
  plugpay_protected, visibility_score, trust_score
) VALUES (
  'f7200000-0000-4000-8000-000000000001',
  'f7100000-0000-4000-8000-000000000001',
  'Trust scan fixture',
  'A normal listing description without contact details',
  'Other',
  12000,
  'active',
  'University of Lagos',
  false,
  50,
  50
);

SELECT is(
  (SELECT trust_score FROM public.listings WHERE id = 'f7200000-0000-4000-8000-000000000001'),
  55,
  'The internal trust scanner can update derived metadata for an authenticated listing'
);

SELECT throws_ok(
  $$UPDATE public.listings SET trust_score = 99 WHERE id = 'f7200000-0000-4000-8000-000000000001'$$,
  'P0001',
  'Listing trust metadata is system-managed',
  'A seller cannot directly forge listing trust metadata'
);

SELECT throws_ok(
  $$UPDATE public.listings SET status = 'sold' WHERE id = 'f7200000-0000-4000-8000-000000000001'$$,
  'P0001',
  'Listing status is managed by the transaction system',
  'The trust-scan capability cannot bypass listing lifecycle controls'
);

RESET ROLE;
ROLLBACK;
