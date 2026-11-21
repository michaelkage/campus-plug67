BEGIN;
SELECT plan(17);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('f6100000-0000-4000-8000-000000000001','authenticated','authenticated','journal-buyer@test.invalid','',now(),'{}'::jsonb,'{"full_name":"Journal Buyer"}'::jsonb,now(),now()),
  ('f6100000-0000-4000-8000-000000000002','authenticated','authenticated','journal-seller@test.invalid','',now(),'{}'::jsonb,'{"full_name":"Journal Seller"}'::jsonb,now(),now());

INSERT INTO public.listings (id,seller_id,title,category,price,status,university)
VALUES ('f6200000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002','Journal fixture','Other',10000,'sold','University of Lagos');

-- Verified Paystack funding must create debit Paystack clearing / credit escrow.
INSERT INTO public.transactions (
  id,listing_id,buyer_id,seller_id,amount,status,payment_method,
  paystack_ref,payment_verified,payout_status,escrow_status
) VALUES (
  'f6300000-0000-4000-8000-000000000001',
  'f6200000-0000-4000-8000-000000000001',
  'f6100000-0000-4000-8000-000000000001',
  'f6100000-0000-4000-8000-000000000002',
  10000,'locked','paystack','journal-fixture-payment-1',true,
  'approved_for_settlement','held'
);

SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key='paystack-escrow-funded:f6300000-0000-4000-8000-000000000001'),
  1,'Verified Paystack payment posts one escrow funding journal'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_entries e
    JOIN public.financial_journal_transactions t ON t.id=e.journal_transaction_id
    WHERE t.idempotency_key='paystack-escrow-funded:f6300000-0000-4000-8000-000000000001'),
  2,'Paystack funding journal has two balanced account lines'
);

-- Escrow resolution creates seller payable, but does not mark bank payout paid.
SELECT set_config('app.escrow_transition','true',true);
UPDATE public.transactions SET status='released',released_at=now(),completed_at=now()
 WHERE id='f6300000-0000-4000-8000-000000000001';
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key='paystack-escrow-released:f6300000-0000-4000-8000-000000000001'),
  1,'Escrow release recognizes seller payable exactly once'
);
SELECT is(
  (SELECT payout_status FROM public.transactions WHERE id='f6300000-0000-4000-8000-000000000001'),
  'approved_for_settlement','Escrow release does not pretend bank payout is complete'
);

SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
SELECT public.post_seller_payout_journal_event(
  'f6300000-0000-4000-8000-000000000001',
  'cp_tr_journalfixture0001',10000,'success'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key='paystack-payout:cp_tr_journalfixture0001:success'),
  1,'Provider-confirmed payout posts seller payable settlement'
);
SELECT lives_ok(
  $$ SELECT public.post_seller_payout_journal_event(
    'f6300000-0000-4000-8000-000000000001',
    'cp_tr_journalfixture0001',10000,'success'
  ) $$,
  'Duplicate payout success is idempotent'
);

UPDATE public.transactions SET payout_status='paid',refund_status='processed'
 WHERE id='f6300000-0000-4000-8000-000000000001';
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key='paystack-escrow-refunded:f6300000-0000-4000-8000-000000000001'),
  1,'Confirmed post-payout refund creates a seller recovery receivable'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_entries e
    JOIN public.financial_accounts a ON a.id=e.account_id
    JOIN public.financial_journal_transactions t ON t.id=e.journal_transaction_id
    WHERE t.idempotency_key='paystack-escrow-refunded:f6300000-0000-4000-8000-000000000001'
      AND a.account_code='asset.seller_recovery'
      AND a.owner_id='f6100000-0000-4000-8000-000000000002'
      AND e.debit=10000),
  1,'Post-payout refund is attributed to the correct seller receivable'
);

SELECT public.post_seller_payout_journal_event(
  'f6300000-0000-4000-8000-000000000001',
  'cp_tr_journalfixture0001',10000,'reversed'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key='paystack-payout:cp_tr_journalfixture0001:reversed'),
  1,'Provider reversal creates a separate compensating journal'
);

-- Compatibility wallet funding rows are projected into double-entry accounts.
INSERT INTO public.financial_ledger (
  user_id,amount,currency,direction,source,reference_type,reference_id,
  idempotency_key,metadata
) VALUES (
  'f6100000-0000-4000-8000-000000000001',2500,'NGN','credit','plug_credit_ledger',
  'plug_credit_ledger','f6400000-0000-4000-8000-000000000001',
  'journal-fixture-wallet-funding',
  '{"legacy_reason":"Campus Wallet funding","legacy_reference_id":null}'::jsonb
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key='financial-ledger:' || (
      SELECT id::text FROM public.financial_ledger WHERE idempotency_key='journal-fixture-wallet-funding'
    )),
  1,'Legacy Campus Wallet funding is mirrored into the double-entry journal'
);

SELECT ok(
  (SELECT total_debits=total_credits AND imbalance=0
     FROM public.financial_journal_trial_balance WHERE currency='NGN'),
  'Journal trial balance remains balanced'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM public.financial_journal_transactions t
    LEFT JOIN public.financial_journal_entries e ON e.journal_transaction_id=t.id
    GROUP BY t.id HAVING count(e.id)<2 OR sum(e.debit)<>sum(e.credit)
  ),
  'Every posted journal transaction has at least two balanced lines'
);
SELECT throws_ok(
  $$ UPDATE public.financial_journal_entries SET debit=debit+1
      WHERE journal_transaction_id=(
        SELECT id FROM public.financial_journal_transactions
         WHERE idempotency_key='paystack-escrow-funded:f6300000-0000-4000-8000-000000000001'
      ) LIMIT 1 $$,
  'P0001',
  'Financial journal records are immutable; post a compensating journal transaction',
  'Journal entry history cannot be edited'
);
SELECT throws_ok(
  $$ SELECT public.post_financial_journal_transaction(
    'invalid.unbalanced','test','fixture',NULL,'journal-fixture-unbalanced',
    jsonb_build_array(
      jsonb_build_object('account_id',(
        SELECT id FROM public.financial_accounts WHERE account_code='asset.paystack_clearing' AND owner_id IS NULL LIMIT 1
      ),'debit',100,'credit',0),
      jsonb_build_object('account_id',(
        SELECT id FROM public.financial_accounts WHERE account_code='liability.escrow' AND owner_id='f6300000-0000-4000-8000-000000000001' LIMIT 1
      ),'debit',0,'credit',99)
    ),'{}'::jsonb
  ) $$,
  'P0001',
  'Unbalanced financial journal: debits 100, credits 99',
  'Unbalanced journal postings are rejected before commit'
);
SELECT is(
  has_table_privilege('authenticated','public.financial_journal_entries','SELECT'),
  false,'Authenticated clients cannot read raw journal entries'
);

SELECT * FROM finish();
ROLLBACK;
