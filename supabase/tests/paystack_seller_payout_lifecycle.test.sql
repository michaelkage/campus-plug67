BEGIN;
SELECT plan(49);

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

INSERT INTO public.listings (id, seller_id, title, category, price, status, university)
VALUES (
  'f5200000-0000-4000-8000-000000000002',
  'f5100000-0000-4000-8000-000000000002',
  'Disputed payout fixture', 'Other', 15000, 'sold', 'University of Lagos'
);

INSERT INTO public.transactions (
  id, listing_id, buyer_id, seller_id, amount, status,
  payment_method, paystack_ref, payment_verified, payout_status,
  released_at, completed_at, payout_approved_at
) VALUES
(
  'f5300000-0000-4000-8000-000000000001',
  'f5200000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000002',
  12500, 'released', 'paystack', 'payout-fixture-reference-1',
  true, 'approved_for_settlement', now(), now(), now()
),
(
  'f5300000-0000-4000-8000-000000000002',
  'f5200000-0000-4000-8000-000000000002',
  'f5100000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000002',
  15000, 'released', 'paystack', 'payout-fixture-reference-2',
  true, 'approved_for_settlement', now(), now(), now()
);

INSERT INTO public.jury_cases (
  id, transaction_id, claimant_id, respondent_id, dispute_reason, amount, status
) VALUES (
  'f5400000-0000-4000-8000-000000000001',
  'f5300000-0000-4000-8000-000000000002',
  'f5100000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000002',
  'Payout must remain paused while dispute is open',
  15000,
  'open'
);

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
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
SELECT is(has_table_privilege('service_role', 'public.seller_payout_recipients', 'DELETE'), false, 'Recipient history cannot be deleted');
SELECT is(has_table_privilege('service_role', 'public.seller_payout_transfers', 'DELETE'), false, 'Transfer audit history cannot be deleted');
SELECT throws_ok(
  $$ UPDATE public.seller_payout_recipients SET account_last4 = '9999' WHERE seller_id = 'f5100000-0000-4000-8000-000000000002' $$,
  'P0001',
  'Verified payout recipient identity is immutable; create a new recipient instead',
  'Verified recipient identity cannot be rewritten'
);

CREATE TEMP TABLE payout_claim AS
SELECT * FROM public.claim_seller_payout_transfers(10);

SELECT is((SELECT count(*)::integer FROM payout_claim), 1, 'Eligible released Paystack escrow is claimed once');
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'processing', 'Claim moves transaction into payout processing');
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000002'), 'approved_for_settlement', 'Open dispute prevents payout claim');
SELECT ok((SELECT reference ~ '^cp_tr_[a-f0-9]{32}$' FROM payout_claim), 'Transfer reference is stable-format and Paystack compatible');

-- Rotate the seller's active bank account after the first attempt has been
-- claimed. Lease recovery must keep the original beneficiary; a later new
-- attempt after a conclusive reversal must use the newly active beneficiary.
SELECT public.save_seller_payout_recipient(
  'f5100000-0000-4000-8000-000000000002',
  'RCP_payoutfixture2',
  '058',
  'Guaranty Trust Bank',
  'Payout Seller',
  '8765'
);
UPDATE public.seller_payout_transfers
   SET lease_expires_at = now() - interval '1 second'
 WHERE reference = (SELECT reference FROM payout_claim);
CREATE TEMP TABLE payout_recovery AS
SELECT * FROM public.claim_seller_payout_transfers(10);
SELECT is((SELECT count(*)::integer FROM payout_recovery), 1, 'Expired in-flight attempt is safely reclaimed');
SELECT is((SELECT reference FROM payout_recovery), (SELECT reference FROM payout_claim), 'Ambiguous recovery reuses the exact original provider reference');
SELECT is((SELECT recipient_code FROM payout_recovery), 'RCP_payoutfixture1', 'Ambiguous recovery remains bound to the original recipient snapshot');
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
SELECT is((SELECT total_earnings::bigint FROM public.profiles WHERE id = 'f5100000-0000-4000-8000-000000000002'), 12500::bigint, 'Confirmed payout credits seller earnings exactly once');

SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'success', 12500, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', NULL
  )->>'duplicate_or_stale')::boolean,
  true,
  'Duplicate success webhook is idempotent'
);
SELECT is((SELECT total_earnings::bigint FROM public.profiles WHERE id = 'f5100000-0000-4000-8000-000000000002'), 12500::bigint, 'Duplicate success does not double-credit earnings');

SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'reversed', 12500, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', 'Bank reversed the transfer'
  )->>'status'),
  'reversed',
  'A provider reversal is recorded as a distinct terminal state'
);
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'failed', 'Reversed payout is no longer represented as paid');
SELECT is((SELECT total_earnings::bigint FROM public.profiles WHERE id = 'f5100000-0000-4000-8000-000000000002'), 0::bigint, 'Reversal compensates the previously credited seller earnings');
SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_claim), 'success', 12500, 'NGN',
    'RCP_payoutfixture1', 'TRF_payoutfixture1', '51001', NULL
  )->>'duplicate_or_stale')::boolean,
  true,
  'Late success cannot overwrite a conclusive transfer reversal'
);
SELECT is((SELECT total_earnings::bigint FROM public.profiles WHERE id = 'f5100000-0000-4000-8000-000000000002'), 0::bigint, 'Late success after reversal cannot restore earnings');
SELECT throws_ok(
  $$ UPDATE public.seller_payout_transfers SET amount_kobo = 12499 WHERE reference = (SELECT reference FROM payout_claim) $$,
  'P0001',
  'Payout transfer financial identity is immutable',
  'Transfer amount cannot be changed after claim'
);
SELECT throws_ok(
  $$ UPDATE public.seller_payout_transfers SET status = 'success' WHERE reference = (SELECT reference FROM payout_claim) $$,
  'P0001',
  'Terminal payout attempt status is immutable',
  'A reversed transfer cannot be manually changed back to success'
);

UPDATE public.seller_payout_transfers
   SET updated_at = now() - interval '10 minutes'
 WHERE transaction_id = 'f5300000-0000-4000-8000-000000000001';

CREATE TEMP TABLE payout_retry AS
SELECT * FROM public.claim_seller_payout_transfers(10);

SELECT is((SELECT count(*)::integer FROM payout_retry), 1, 'Conclusive reversal can be retried through a new transfer attempt');
SELECT is((SELECT attempt_number::integer FROM payout_retry), 2, 'Retry increments the attempt number');
SELECT isnt((SELECT reference FROM payout_retry), (SELECT reference FROM payout_claim), 'Retry creates a new provider reference after conclusive reversal');
SELECT is((SELECT recipient_code FROM payout_retry), 'RCP_payoutfixture2', 'A new attempt after conclusive failure uses the seller''s newly verified active recipient');
SELECT is((SELECT count(*)::integer FROM public.seller_payout_transfers WHERE transaction_id = 'f5300000-0000-4000-8000-000000000001'), 2, 'Each provider attempt remains separately auditable');
SELECT is(
  (public.record_paystack_transfer(
    (SELECT reference FROM payout_retry), 'otp', 12500, 'NGN',
    'RCP_payoutfixture2', 'TRF_payoutfixture2', '51002', 'Merchant OTP approval required'
  )->>'status'),
  'needs_attention',
  'OTP-required transfers are moved to manual attention rather than auto-finalized'
);
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'needs_attention', 'OTP state is visible in the transaction payout status');
SELECT is((SELECT count(*)::integer FROM public.claim_seller_payout_transfers(10)), 0, 'OTP-required payout is not resubmitted by the automatic worker');
SELECT throws_ok(
  $$ SELECT public.confirm_paystack_transfer_not_created(
    (SELECT reference FROM payout_retry),
    'Support checked the Paystack dashboard and found no transfer.'
  ) $$,
  'P0001',
  'Transfer is not eligible for manual not-created confirmation',
  'OTP transfer with provider identifiers cannot be falsely marked absent'
);

INSERT INTO public.seller_payout_transfers (
  transaction_id, seller_id, recipient_id, attempt_number,
  reference, amount_kobo, currency, status, submission_attempts,
  created_at, updated_at
) VALUES (
  'f5300000-0000-4000-8000-000000000001',
  'f5100000-0000-4000-8000-000000000002',
  (SELECT id FROM public.seller_payout_recipients WHERE seller_id = 'f5100000-0000-4000-8000-000000000002' AND is_active),
  3,
  'cp_tr_manualfixture3',
  12500, 'NGN', 'needs_attention', 1,
  now() - interval '31 minutes', now() - interval '31 minutes'
);

UPDATE public.transactions
   SET payout_reference = 'cp_tr_manualfixture3'
 WHERE id = 'f5300000-0000-4000-8000-000000000001';

SELECT is(
  (public.confirm_paystack_transfer_not_created(
    'cp_tr_manualfixture3',
    'Support verified the reference is absent from the Paystack dashboard.'
  )->>'retry_eligible')::boolean,
  true,
  'Manual no-transfer confirmation requires a mature, provider-absent reference and remains retry eligible'
);
SELECT is((SELECT status FROM public.seller_payout_transfers WHERE reference = 'cp_tr_manualfixture3'), 'failed', 'Manual confirmation closes only the uncreated attempt');
SELECT is((SELECT payout_status FROM public.transactions WHERE id = 'f5300000-0000-4000-8000-000000000001'), 'failed', 'Manual no-transfer confirmation makes the payout safely retryable');

UPDATE public.seller_payout_transfers
   SET updated_at = now() - interval '16 minutes'
 WHERE reference = 'cp_tr_manualfixture3';

CREATE TEMP TABLE payout_manual_retry AS
SELECT * FROM public.claim_seller_payout_transfers(10);

SELECT is((SELECT count(*)::integer FROM payout_manual_retry), 1, 'Manually confirmed absent transfer can be retried with a new attempt');
SELECT is((SELECT attempt_number::integer FROM payout_manual_retry), 4, 'Manual recovery preserves attempt history and increments attempt number');

SELECT * FROM finish();
ROLLBACK;
