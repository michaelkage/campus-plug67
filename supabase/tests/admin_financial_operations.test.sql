BEGIN;
SELECT plan(9);

SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SELECT throws_ok(
  $$ SELECT public.get_admin_financial_operations_snapshot(30) $$,
  'P0001',
  'Platform admin required',
  'Non-admin sessions cannot read financial operations'
);
SELECT is(
  has_function_privilege('anon', 'public.get_admin_financial_operations_snapshot(integer)', 'EXECUTE'),
  false,
  'Anonymous users cannot execute the financial operations snapshot'
);
SELECT is(
  has_function_privilege('authenticated', 'public.get_admin_financial_operations_snapshot(integer)', 'EXECUTE'),
  true,
  'Authenticated users can reach the RPC but remain subject to its server-side admin check'
);


-- Exercise the real payout attention and stale-attempt selectors with isolated rows.
INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('a7100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'admin-finops-buyer@test.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('a7100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'admin-finops-seller@test.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

INSERT INTO public.listings (id, seller_id, title, category, price, status, university)
VALUES
  ('a7200000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-000000000002', 'Admin attention fixture', 'Other', 12500, 'sold', 'University of Lagos'),
  ('a7200000-0000-4000-8000-000000000002', 'a7100000-0000-4000-8000-000000000002', 'Admin stale fixture', 'Other', 15000, 'sold', 'University of Lagos');

INSERT INTO public.transactions (
  id, listing_id, buyer_id, seller_id, amount, status,
  payment_method, paystack_ref, payment_verified, payout_status,
  released_at, completed_at, payout_approved_at
) VALUES
  ('a7300000-0000-4000-8000-000000000001', 'a7200000-0000-4000-8000-000000000001',
   'a7100000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-000000000002',
   12500, 'released', 'paystack', 'admin-finops-attention-ref', true, 'needs_attention', now(), now(), now()),
  ('a7300000-0000-4000-8000-000000000002', 'a7200000-0000-4000-8000-000000000002',
   'a7100000-0000-4000-8000-000000000001', 'a7100000-0000-4000-8000-000000000002',
   15000, 'released', 'paystack', 'admin-finops-stale-ref', true, 'processing', now(), now(), now());

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

INSERT INTO public.seller_payout_recipients (
  seller_id, recipient_code, bank_code, bank_name,
  account_name, account_last4, is_active, verified_at
) VALUES (
  'a7100000-0000-4000-8000-000000000002',
  'RCP_adminfinopsfixture', '044', 'Access Bank',
  'Admin Finops Seller', '4321', true, now()
);

INSERT INTO public.seller_payout_transfers (
  transaction_id, seller_id, recipient_id, attempt_number,
  reference, amount_kobo, currency, status, submission_attempts,
  created_at, updated_at, last_reconciled_at, lease_expires_at
)
SELECT
  'a7300000-0000-4000-8000-000000000001',
  'a7100000-0000-4000-8000-000000000002',
  id, 1, 'cp_tr_admin_attention_001', 12500, 'NGN',
  'needs_attention', 1, now() - interval '1 hour',
  now() - interval '20 minutes', now() - interval '20 minutes', NULL
FROM public.seller_payout_recipients
WHERE recipient_code = 'RCP_adminfinopsfixture';

INSERT INTO public.seller_payout_transfers (
  transaction_id, seller_id, recipient_id, attempt_number,
  reference, amount_kobo, currency, status, submission_attempts,
  created_at, updated_at, last_reconciled_at, lease_expires_at
)
SELECT
  'a7300000-0000-4000-8000-000000000002',
  'a7100000-0000-4000-8000-000000000002',
  id, 1, 'cp_tr_admin_stale_001', 15000, 'NGN',
  'pending', 1, now() - interval '1 hour',
  now() - interval '20 minutes', now() - interval '20 minutes',
  now() - interval '10 minutes'
FROM public.seller_payout_recipients
WHERE recipient_code = 'RCP_adminfinopsfixture';

SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"role":"platform_admin"}}',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SELECT ok(
  public.get_admin_financial_operations_snapshot(30) ? 'generated_at',
  'Platform admins can read the financial operations snapshot'
);
SELECT is(
  jsonb_typeof(public.get_admin_financial_operations_snapshot(30)->'payout_attention'),
  'array',
  'Payout attention queue is returned as a bounded array'
);
SELECT is(
  jsonb_typeof(public.get_admin_financial_operations_snapshot(30)->'payout_operator_audit'),
  'array',
  'Operator audit history is returned as a bounded array'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.get_admin_financial_operations_snapshot(30)->'payout_attention') AS rows(item)
    WHERE item->>'reference' = 'cp_tr_admin_attention_001'
  ),
  'Snapshot includes the latest payout attempt requiring operator attention'
);
SELECT ok(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(public.get_admin_financial_operations_snapshot(30)->'stale_payouts') AS rows(item)
    WHERE item->>'reference' = 'cp_tr_admin_stale_001'
  ),
  'Snapshot includes a pending payout whose reconciliation timestamp and lease are stale'
);

SELECT throws_ok(
  $ SELECT public.get_admin_financial_operations_snapshot(101) $,
  'P0001',
  'Limit must be between 1 and 100',
  'Snapshot rejects unbounded result limits'
);

SELECT * FROM finish();
ROLLBACK;
