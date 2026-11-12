BEGIN;
SELECT plan(25);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('f4100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'refund-buyer@test.invalid', '', now(), '{}'::jsonb, '{"full_name":"Refund Buyer"}'::jsonb, now(), now()),
  ('f4100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'refund-seller@test.invalid', '', now(), '{}'::jsonb, '{"full_name":"Refund Seller"}'::jsonb, now(), now());

INSERT INTO public.listings (id, seller_id, title, category, price, status, university)
VALUES
  ('f4200000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000002', 'Refund fixture one', 'Other', 10000, 'reserved', 'University of Lagos'),
  ('f4200000-0000-4000-8000-000000000002', 'f4100000-0000-4000-8000-000000000002', 'Refund fixture two', 'Other', 20000, 'reserved', 'University of Lagos');

INSERT INTO public.transactions (
  id, listing_id, buyer_id, seller_id, amount, status, payment_method, paystack_ref
) VALUES
  ('f4300000-0000-4000-8000-000000000001', 'f4200000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000002', 10000, 'locked', 'paystack', 'refund-fixture-reference-1'),
  ('f4300000-0000-4000-8000-000000000002', 'f4200000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000002', 20000, 'locked', 'paystack', 'refund-fixture-reference-2');

SELECT set_config('request.jwt.claim.role', 'service_role', true);
UPDATE public.listings SET status = 'sold' WHERE id = 'f4200000-0000-4000-8000-000000000001';

SELECT is(
  has_function_privilege('authenticated', 'public.record_paystack_refund(text,text,text,bigint,text)', 'EXECUTE'),
  false,
  'Only service role can record provider refund events'
);

SELECT is((public.record_paystack_refund('refund-fixture-reference-1', NULL, 'pending', 10000, 'NGN')->>'status'), 'pending', 'Paystack pending event is accepted without a refund reference');
SELECT is((SELECT count(*)::integer FROM public.paystack_refund_records WHERE transaction_id = 'f4300000-0000-4000-8000-000000000001' AND refund_reference IS NULL), 1, 'Pending event is persisted with a null provider reference');
SELECT is((SELECT refund_status FROM public.transactions WHERE id = 'f4300000-0000-4000-8000-000000000001'), 'pending', 'Transaction refund summary reflects pending provider state');
SELECT is((SELECT status FROM public.listings WHERE id = 'f4200000-0000-4000-8000-000000000001'), 'sold', 'Pending refund does not return the listing to active inventory');

SELECT is((public.record_paystack_refund('refund-fixture-reference-1', '991', 'processing', 10000, 'NGN')->>'status'), 'processing', 'Processing event correlates to the pending refund row');
SELECT is((SELECT count(*)::integer FROM public.paystack_refund_records WHERE transaction_id = 'f4300000-0000-4000-8000-000000000001'), 1, 'Processing event updates rather than duplicates the pending refund');
SELECT is((SELECT refund_reference FROM public.paystack_refund_records WHERE transaction_id = 'f4300000-0000-4000-8000-000000000001'), '991', 'Later provider id is attached to the original pending row');
SELECT is((public.record_paystack_refund('refund-fixture-reference-1', NULL, 'pending', 10000, 'NGN')->>'duplicate_or_stale')::boolean, true, 'Delayed pending event is acknowledged as stale');
SELECT is((SELECT status FROM public.paystack_refund_records WHERE transaction_id = 'f4300000-0000-4000-8000-000000000001'), 'processing', 'Delayed pending event cannot downgrade processing');

SELECT is((public.record_paystack_refund('refund-fixture-reference-1', '991', 'needs-attention', 10000, 'NGN')->>'status'), 'needs-attention', 'Needs-attention status is stored in canonical Paystack spelling');
SELECT is((public.claim_paystack_refund('f4300000-0000-4000-8000-000000000001')->>'claimed')::boolean, false, 'Needs-attention refund blocks a duplicate provider refund request');
SELECT set_config('app.escrow_transition', 'true', true);
UPDATE public.transactions SET status = 'cancelled', cancelled_at = now() WHERE id = 'f4300000-0000-4000-8000-000000000001';
SELECT is((public.record_paystack_refund('refund-fixture-reference-1', '991', 'processed', 10000, 'NGN')->>'status'), 'processed', 'Processed event completes the refund lifecycle');
SELECT is((SELECT status FROM public.listings WHERE id = 'f4200000-0000-4000-8000-000000000001'), 'active', 'Only confirmed refund processing returns cancelled inventory to active');
SELECT is((public.record_paystack_refund('refund-fixture-reference-1', NULL, 'pending', 10000, 'NGN')->>'duplicate_or_stale')::boolean, true, 'Delayed pending event cannot reopen a completed refund');

SELECT throws_ok($$ SELECT public.record_paystack_refund('refund-fixture-reference-2', '991', 'processing', 20000, 'NGN') $$, 'P0001', 'Refund reference is already bound to another transaction', 'Provider refund reference cannot be rebound across transactions');
SELECT throws_ok($$ SELECT public.record_paystack_refund('refund-fixture-reference-2', NULL, 'pending', 19999, 'NGN') $$, 'P0001', 'Refund amount does not match the full escrow amount', 'Provider refund amount must match the full escrow amount');

SELECT is((public.record_paystack_refund('refund-fixture-reference-2', '992', 'failed', 20000, 'NGN')->>'status'), 'failed', 'Failed provider refund is recorded as terminal for its attempt');
UPDATE public.transactions SET status = 'cancelled', cancelled_at = now() WHERE id = 'f4300000-0000-4000-8000-000000000002';
UPDATE public.listings SET status = 'sold' WHERE id = 'f4200000-0000-4000-8000-000000000002';
SELECT is((public.claim_paystack_refund('f4300000-0000-4000-8000-000000000002')->>'claimed')::boolean, true, 'A failed refund can be retried after escrow cancellation');
SELECT ok((SELECT refund_request_reference ~ '^cp_rf_[A-Fa-f0-9]{32}$' FROM public.transactions WHERE id = 'f4300000-0000-4000-8000-000000000002'), 'Retry persists a Paystack-compatible unique request reference');
SELECT is((public.claim_paystack_refund('f4300000-0000-4000-8000-000000000002')->>'request_reference'), (SELECT refund_request_reference FROM public.transactions WHERE id = 'f4300000-0000-4000-8000-000000000002'), 'A concurrent or repeated claim reuses the same in-flight request reference');
SELECT is((public.record_paystack_refund('refund-fixture-reference-2', NULL, 'pending', 20000, 'NGN')->>'status'), 'pending', 'New retry accepts its null-reference pending event');
SELECT is((SELECT count(*)::integer FROM public.paystack_refund_records WHERE transaction_id = 'f4300000-0000-4000-8000-000000000002'), 2, 'Retry creates a new attempt instead of mutating the previous failed attempt');
SELECT is((SELECT paystack_refund_id FROM public.transactions WHERE id = 'f4300000-0000-4000-8000-000000000002'), NULL, 'Starting a new attempt clears the previous provider id from the transaction summary');
SELECT is((SELECT status FROM public.listings WHERE id = 'f4200000-0000-4000-8000-000000000002'), 'sold', 'A retried pending refund keeps the listing unavailable');

SELECT * FROM finish();
ROLLBACK;
