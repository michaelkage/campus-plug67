BEGIN;
SELECT plan(29);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('f5100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'payout-buyer@test.invalid', '', now(), '{}'::jsonb, '{"full_name":"Payout Buyer"}'::jsonb, now(), now()),
  ('f5100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'payout-seller@test.invalid', '', now(), '{}'::jsonb, '{"full_name":"Payout Seller"}'::jsonb, now(), now());

INSERT INTO public.listings (id, seller_id, title, category, price, status, university)
VALUES (
  'f5200000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000002',
  'Seller payout fixture', 'Other', 12500, 'sold', 'University of Lagos'
);

INSERT INTO public.transactions (
  id, listing_id, buyer_id, seller_id, amount, status,
  payment_method, paystack_ref, payment_verified, payout_status,
  released_at, completed_at, payout_approved_at
) VALUES (
  'f5300000-0000-4000-8000-000000000001',
  'f5200000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000002',
  12500, 'released', 'paystack', 'payout-fixture-reference-1',
  true, 'approved_for_settlement', now(), now(), now()
);

SELECT set_config('request.jwt.claim.role', 'service_role', true);

INSERT INTO public.seller_payout_recipients (
  seller_id, recipient_code, bank_code, bank_name,
  account_name, account_last4, is_active, verified_at
) VALUES (
  'f5100000-0000-4000-8000-000000000002',
  'RCP_payoutfixture1', '044', 'Access Bank',
  'Payout Seller', '4321', true, now()
);

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.seller_payout_recipients'::regclass),
  'Seller payout recipients have RLS enabled'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.seller_payout_transfers'::regclass),
  'Seller payout transfers have RLS enabled'
);
SELECT is(has_table_privilege('authenticated', 'public.seller_payout_recipients', 'SELECT'), false, 'Authenticated users cannot read recipient records');
SELECT is(has_table_privilege('authenticated', 'public.seller_payout_recipients', 'INSERT'), false, 'Authenticated users cannot insert recipient records');
SELECT is(has_table_privilege('authenticated', 'public.seller_payout_transfers', 'SELECT'), false, 'Authenticated users cannot read transfer records');
SELECT is(
  (SELECT count(*)::integer FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'seller_payout_recipients'
      AND column_name = 'account_number'),
  0,
  'Full bank account numbers are never stored'
);
SELECT is(has_function_privilege('authenticated', 'public.save_seller_payout_recipient(uuid,text,text,text,text,text)', 'EXECUTE'), false, 'Only service role can persist provider recipients');
SELECT is(has_function_privilege('authenticated', 'public.claim_seller_payout_transfers(integer)', 'EXECUTE'), false, 'Only service role can claim seller transfers');
SELECT is(has_function_privilege('authenticated', 'public.record_paystack_transfer(text,text,bigint,text,text,text,text,text)', 'EXECUTE'), false, 'Only service role can record provider transfer events');

CREATE TEMP TABLE payout_claim AS
SELECT * FROM public.claim_seller_payout_transfers(10);

SELECT is((SELECT count(*)::integer FROM payout_claim), 1, 'Eligible released Paystack escrow is claimed once');
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'processing', 'Claim moves transaction into payout processing');
SELECT ok((SELECT reference ~ '^cp_tr_[a-f0-9]{32}$' FROM payout_claim), 'Transfer reference is stable-format and Paystack compatible');
SELECT is((SELECT count(*)::integer FROM public.claim_seller_payout_transfers(10)), 0, 'Concurrent claim cannot create a second in-flight transfer');

SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'pending', 12500, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', NULL
  )->>'status'),
  'pending',
  'Provider pending state is recorded without marking the seller paid'
);
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'processing', 'Pending provider transfer remains unpaid');

SELECT throws_ok(
  $$ SELECT public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'success', 12499, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', NULL
  ) $$,
  'P0001',
  'Paystack transfer does not match the approved escrow payout',
  'Provider amount mismatch cannot mark seller paid'
);

SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'success', 12500, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', NULL
  )->>'status'),
  'success',
  'Only provider success confirms seller payout'
);
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'paid', 'Confirmed provider success marks transaction payout paid');
SELECT is((SELECT total_earnings FROM public.profiles WHERE id = 'f5100000-0000-4000-8000-000000000002'), 12500::bigint, 'Confirmed payout credits seller earnings exactly once');

SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'success', 12500, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', NULL
  )->>'duplicate_or_stale')::boolean,
  true,
  'Duplicate success webhook is idempotent'
);
SELECT is((SELECT total_earnings FROM public.profiles WHERE id = 'f5100000-0000-4000-8000-000000000002'), 12500::bigint, 'Duplicate success does not double-credit earnings');

SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'reversed', 12500, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', 'Bank reversed the transfer'
  )->>'status'),
  'reversed',
  'A provider reversal is recorded as a distinct terminal state'
);
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'failed', 'Reversed payout is no longer represented as paid');
SELECT is((SELECT total_earnings FROM public.profiles WHERE id = 'f5100000-0000-4000-8000-000000000002'), 0::bigint, 'Reversal compensates the previously credited seller earnings');

UPDATE public.seller_payout_transfers
   SET updated_at = now() - interval '10 minutes'
 WHERE transaction_id = 'f5300000-0000-4000-8000-000000000001';

CREATE TEMP TABLE payout_retry AS
SELECT * FROM public.claim_seller_payout_transfers(10);

SELECT is((SELECT count(*)::integer FROM payout_retry), 1, 'Conclusive reversal can be retried through a new transfer attempt');
SELECT is((SELECT attempt_number::integer FROM payout_retry), 2, 'Retry increments the attempt number');
SELECT isnt((SELECT reference FROM payout_retry), (SELECT reference FROM payout_claim), 'Retry creates a new provider reference after conclusive reversal');
SELECT is((SELECT recipient_code FROM payout_retry), 'RCP_payoutfixture1', 'Retry remains bound to the verified active recipient');
SELECT is((SELECT count(*)::integer FROM public.seller_payout_transfers WHERE transaction_id = 'f5300000-0000-4000-8000-000000000001'), 2, 'Each provider attempt remains separately auditable');

SELECT * FROM finish();
ROLLBACK;
