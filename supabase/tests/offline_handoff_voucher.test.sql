BEGIN;

SELECT plan(8);

-- Exercise the escrow RPC/trigger path as trusted database code, not as a browser row update.
SELECT set_config('app.escrow_transition', 'true', true);

-- Isolated database-level trigger tests. These fixtures are rolled back at the end.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('f1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'offline-buyer@test.invalid', '', now(), '{}'::jsonb, '{"full_name":"Offline Buyer"}'::jsonb, now(), now()),
  ('f1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'offline-seller@test.invalid', '', now(), '{}'::jsonb, '{"full_name":"Offline Seller"}'::jsonb, now(), now());

INSERT INTO public.listings (id, seller_id, title, category, price, status, university)
VALUES
  ('f2000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002', 'Offline trigger fixture 1', 'Other', 10000, 'reserved', 'University of Lagos'),
  ('f2000000-0000-4000-8000-000000000002', 'f1000000-0000-4000-8000-000000000002', 'Offline trigger fixture 2', 'Other', 10000, 'reserved', 'University of Lagos'),
  ('f2000000-0000-4000-8000-000000000003', 'f1000000-0000-4000-8000-000000000002', 'Offline trigger fixture 3', 'Other', 10000, 'reserved', 'University of Lagos'),
  ('f2000000-0000-4000-8000-000000000004', 'f1000000-0000-4000-8000-000000000002', 'Offline trigger fixture 4', 'Other', 10000, 'reserved', 'University of Lagos'),
  ('f2000000-0000-4000-8000-000000000005', 'f1000000-0000-4000-8000-000000000002', 'Offline trigger fixture 5', 'Other', 10000, 'reserved', 'University of Lagos');

INSERT INTO public.transactions (
  id, listing_id, buyer_id, seller_id, amount, status,
  buyer_safe_zone_id, seller_safe_zone_id, payment_method
)
SELECT
  fixture.id, fixture.listing_id,
  'f1000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000002',
  10000, 'meetup_initiated', zone.id, zone.id, 'paystack'
FROM (
  VALUES
    ('f3000000-0000-4000-8000-000000000001'::uuid, 'f2000000-0000-4000-8000-000000000001'::uuid),
    ('f3000000-0000-4000-8000-000000000002'::uuid, 'f2000000-0000-4000-8000-000000000002'::uuid),
    ('f3000000-0000-4000-8000-000000000003'::uuid, 'f2000000-0000-4000-8000-000000000003'::uuid),
    ('f3000000-0000-4000-8000-000000000004'::uuid, 'f2000000-0000-4000-8000-000000000004'::uuid),
    ('f3000000-0000-4000-8000-000000000005'::uuid, 'f2000000-0000-4000-8000-000000000005'::uuid)
) AS fixture(id, listing_id)
CROSS JOIN LATERAL (
  SELECT id FROM public.safe_zones
   WHERE university = 'University of Lagos' AND active = true
   ORDER BY id LIMIT 1
) AS zone;

-- 1. The legacy static QR path cannot enter buyer-confirmed inspection.
SELECT throws_ok(
  $$
    UPDATE public.transactions
       SET status = 'release_requested',
           release_requested_at = now(),
           auto_release_at = now() + interval '2 hours',
           handshake_receipt_buffer = now()
     WHERE id = 'f3000000-0000-4000-8000-000000000001'
  $$,
  'P0001',
  'A valid one-time offline handoff voucher is required to confirm receipt',
  'Legacy static QR confirmation is rejected without a consumed voucher'
);

-- 2. A correctly bound, consumed, unexpired voucher permits the inspection transition.
INSERT INTO public.offline_handoff_vouchers (
  transaction_id, buyer_id, seller_id, amount, safe_zone_id,
  token_hash, expires_at, consumed_at
)
SELECT
  tx.id, tx.buyer_id, tx.seller_id, tx.amount, tx.buyer_safe_zone_id,
  encode(extensions.digest(convert_to('offline-handoff-test-token-0000000000000000', 'UTF8'), 'sha256'), 'hex'), now() + interval '10 minutes', now()
FROM public.transactions AS tx
WHERE tx.id = 'f3000000-0000-4000-8000-000000000002';

SELECT set_config('app.escrow_transition', 'true', true);
SELECT lives_ok(
  $$
    UPDATE public.transactions AS tx
       SET status = 'release_requested',
           release_requested_at = now(),
           auto_release_at = now() + interval '2 hours',
           handshake_receipt_buffer = (
             SELECT voucher.consumed_at
               FROM public.offline_handoff_vouchers AS voucher
              WHERE voucher.transaction_id = tx.id
           )
     WHERE tx.id = 'f3000000-0000-4000-8000-000000000002'
  $$,
  'A matching consumed and unexpired voucher permits inspection'
);

-- 3. The permitted transition is inspection only, never immediate payout.
SELECT is(
  (SELECT status FROM public.transactions WHERE id = 'f3000000-0000-4000-8000-000000000002'),
  'release_requested',
  'Voucher confirmation leaves the transaction in inspection-pending state'
);
SELECT is(
  (SELECT released_at IS NULL FROM public.transactions WHERE id = 'f3000000-0000-4000-8000-000000000002'),
  true,
  'Voucher confirmation does not set a payout timestamp'
);

-- A lost client response may cause the same proof to be synced again. The RPC
-- must return the existing inspection result without changing transaction state.
SELECT set_config('request.jwt.claim.sub', 'f1000000-0000-4000-8000-000000000001', true);
SELECT is(
  (public.confirm_offline_handoff(
    'f3000000-0000-4000-8000-000000000002',
    (SELECT id FROM public.offline_handoff_vouchers WHERE transaction_id = 'f3000000-0000-4000-8000-000000000002'),
    'offline-handoff-test-token-0000000000000000'
  )->>'already_confirmed')::boolean,
  true,
  'A repeated sync returns the existing inspection result idempotently'
);

-- 4. A voucher that expired before consumption cannot authorize inspection.
INSERT INTO public.offline_handoff_vouchers (
  transaction_id, buyer_id, seller_id, amount, safe_zone_id,
  token_hash, expires_at, consumed_at
)
SELECT
  tx.id, tx.buyer_id, tx.seller_id, tx.amount, tx.buyer_safe_zone_id,
  repeat('b', 64), now() - interval '20 minutes', now() - interval '10 minutes'
FROM public.transactions AS tx
WHERE tx.id = 'f3000000-0000-4000-8000-000000000003';

SELECT throws_ok(
  $$
    UPDATE public.transactions AS tx
       SET status = 'release_requested',
           release_requested_at = now(),
           auto_release_at = now() + interval '2 hours',
           handshake_receipt_buffer = (
             SELECT voucher.consumed_at
               FROM public.offline_handoff_vouchers AS voucher
              WHERE voucher.transaction_id = tx.id
           )
     WHERE tx.id = 'f3000000-0000-4000-8000-000000000003'
  $$,
  'P0001',
  'A valid one-time offline handoff voucher is required to confirm receipt',
  'Voucher that expired before consumption cannot authorize buyer-confirmed inspection'
);

-- 5. The RPC itself rejects an unconsumed voucher after its server expiry.
INSERT INTO public.offline_handoff_vouchers (
  transaction_id, buyer_id, seller_id, amount, safe_zone_id,
  token_hash, expires_at, consumed_at
)
SELECT
  tx.id, tx.buyer_id, tx.seller_id, tx.amount, tx.buyer_safe_zone_id,
  encode(extensions.digest(convert_to('offline-expired-token-0000000000000000', 'UTF8'), 'sha256'), 'hex'),
  now() - interval '10 minutes', NULL
FROM public.transactions AS tx
WHERE tx.id = 'f3000000-0000-4000-8000-000000000005';

SELECT throws_ok(
  $test$
    SELECT public.confirm_offline_handoff(
      'f3000000-0000-4000-8000-000000000005',
      (SELECT id FROM public.offline_handoff_vouchers WHERE transaction_id = 'f3000000-0000-4000-8000-000000000005'),
      'offline-expired-token-0000000000000000'
    )
  $test$,
  'P0001',
  'Offline handoff QR has expired',
  'Server-side confirmation rejects an unconsumed voucher after expiry'
);

-- 6. Seller-requested release is a separate path and must remain unaffected.
SELECT lives_ok(
  $$
    UPDATE public.transactions
       SET status = 'release_requested',
           release_requested_at = now(),
           auto_release_at = now() + interval '48 hours',
           handshake_receipt_buffer = NULL
     WHERE id = 'f3000000-0000-4000-8000-000000000004'
  $$,
  'Seller-requested release with a null receipt buffer bypasses the buyer voucher guard'
);

SELECT finish();
ROLLBACK;
