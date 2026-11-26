BEGIN;
SELECT plan(34);

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
SELECT set_config('request.jwt.claims','{"role":"service_role"}',true);
SELECT set_config('request.jwt.claim.role','service_role',true);
UPDATE public.transactions SET status='released',released_at=now(),completed_at=now()
 WHERE id='f6300000-0000-4000-8000-000000000001';
-- Legacy generic Paystack release markers must not create a second wallet
-- posting; the transaction-level Paystack release is the accounting event.
INSERT INTO public.financial_ledger (
  user_id,amount,currency,direction,source,reference_type,reference_id,idempotency_key,metadata
) VALUES (
  'f6100000-0000-4000-8000-000000000002',10000,'NGN','credit','plug_credit_ledger',
  'plug_credit_ledger','f6400000-0000-4000-8000-000000000014',
  'journal-fixture-legacy-paystack-auto-release',
  '{"legacy_reason":"Escrow auto-release","legacy_reference_id":"f6300000-0000-4000-8000-000000000001"}'::jsonb
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key='paystack-escrow-released:f6300000-0000-4000-8000-000000000001'),
  1,'Legacy Paystack auto-release marker does not double-post the seller payable'
);

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

-- A refund accepted before the seller transfer is submitted must reduce
-- seller payable. If a transfer nevertheless succeeds afterward, it becomes
-- a recovery receivable; a provider reversal compensates that receivable.
INSERT INTO public.listings (id,seller_id,title,category,price,status,university)
VALUES ('f6200000-0000-4000-8000-000000000004','f6100000-0000-4000-8000-000000000002',
        'Refund-before-payout fixture','Other',7000,'sold','University of Lagos');
INSERT INTO public.transactions (
  id,listing_id,buyer_id,seller_id,amount,status,payment_method,
  paystack_ref,payment_verified,payout_status,escrow_status
) VALUES (
  'f6300000-0000-4000-8000-000000000004',
  'f6200000-0000-4000-8000-000000000004',
  'f6100000-0000-4000-8000-000000000001',
  'f6100000-0000-4000-8000-000000000002',
  7000,'released','paystack','journal-fixture-payment-4',true,
  'approved_for_settlement','released'
);
UPDATE public.transactions SET refund_status='processed'
 WHERE id='f6300000-0000-4000-8000-000000000004';
SELECT public.post_seller_payout_journal_event(
  'f6300000-0000-4000-8000-000000000004','cp_tr_journalfixture0004',7000,'success'
);
SELECT public.post_seller_payout_journal_event(
  'f6300000-0000-4000-8000-000000000004','cp_tr_journalfixture0004',7000,'reversed'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_entries e
    JOIN public.financial_journal_transactions t ON t.id=e.journal_transaction_id
    JOIN public.financial_accounts a ON a.id=e.account_id
    WHERE t.idempotency_key='paystack-escrow-refunded:f6300000-0000-4000-8000-000000000004'
      AND a.account_code='liability.seller_payable' AND e.debit=7000),
  1,'Refund before payout consumes the seller payable'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_entries e
    JOIN public.financial_journal_transactions t ON t.id=e.journal_transaction_id
    JOIN public.financial_accounts a ON a.id=e.account_id
    WHERE t.idempotency_key='paystack-payout:cp_tr_journalfixture0004:success'
      AND a.account_code='asset.seller_recovery' AND e.debit=7000),
  1,'Late payout success after refund is recognized as a seller recovery receivable'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_entries e
    JOIN public.financial_journal_transactions t ON t.id=e.journal_transaction_id
    JOIN public.financial_accounts a ON a.id=e.account_id
    WHERE t.idempotency_key='paystack-payout:cp_tr_journalfixture0004:reversed'
      AND a.account_code='asset.seller_recovery' AND e.credit=7000),
  1,'Late payout reversal clears the recovery receivable'
);

-- Compatibility wallet funding rows are projected into double-entry accounts.
INSERT INTO public.financial_ledger (
  user_id,amount,currency,direction,source,reference_type,reference_id,
  idempotency_key,metadata
) VALUES (
  'f6100000-0000-4000-8000-000000000001',10000,'NGN','credit','plug_credit_ledger',
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

-- Exercise the wallet escrow hold, release and refund reason mappings.
INSERT INTO public.listings (id,seller_id,title,category,price,status,university)
VALUES
  ('f6200000-0000-4000-8000-000000000002','f6100000-0000-4000-8000-000000000002','Wallet release fixture','Other',5000,'sold','University of Lagos'),
  ('f6200000-0000-4000-8000-000000000003','f6100000-0000-4000-8000-000000000002','Wallet refund fixture','Other',3000,'sold','University of Lagos');

INSERT INTO public.transactions (
  id,listing_id,buyer_id,seller_id,amount,status,payment_method,
  paystack_ref,payment_verified,payout_status,escrow_status
) VALUES
  ('f6300000-0000-4000-8000-000000000002','f6200000-0000-4000-8000-000000000002',
   'f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002',
   5000,'locked','campus_wallet',NULL,false,'not_applicable','held'),
  ('f6300000-0000-4000-8000-000000000003','f6200000-0000-4000-8000-000000000003',
   'f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002',
   3000,'locked','campus_wallet',NULL,false,'not_applicable','held');

INSERT INTO public.financial_ledger (
  user_id,amount,currency,direction,source,reference_type,reference_id,idempotency_key,metadata
) VALUES
  ('f6100000-0000-4000-8000-000000000001',5000,'NGN','debit','plug_credit_ledger','plug_credit_ledger',
   'f6400000-0000-4000-8000-000000000002','journal-fixture-wallet-hold-release',
   '{"legacy_reason":"Campus Wallet escrow hold","legacy_reference_id":"f6300000-0000-4000-8000-000000000002"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000002',5000,'NGN','credit','plug_credit_ledger','plug_credit_ledger',
   'f6400000-0000-4000-8000-000000000003','journal-fixture-wallet-release',
   '{"legacy_reason":"Campus Wallet micro-escrow release","legacy_reference_id":"f6300000-0000-4000-8000-000000000002"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000001',3000,'NGN','debit','plug_credit_ledger','plug_credit_ledger',
   'f6400000-0000-4000-8000-000000000004','journal-fixture-wallet-hold-refund',
   '{"legacy_reason":"Campus Wallet escrow hold","legacy_reference_id":"f6300000-0000-4000-8000-000000000003"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000001',3000,'NGN','credit','plug_credit_ledger','plug_credit_ledger',
   'f6400000-0000-4000-8000-000000000005','journal-fixture-wallet-refund',
   '{"legacy_reason":"Campus Wallet micro-escrow refund","legacy_reference_id":"f6300000-0000-4000-8000-000000000003"}'::jsonb);

SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE idempotency_key LIKE 'financial-ledger:%'
      AND metadata->>'legacy_reason'='Campus Wallet escrow hold'),
  2,'Campus Wallet escrow holds create transaction-specific escrow liabilities'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Campus Wallet micro-escrow release'),
  1,'Campus Wallet escrow release credits the seller wallet liability'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Campus Wallet micro-escrow refund'),
  1,'Campus Wallet escrow refund restores the buyer wallet liability'
);

SELECT is(
  (SELECT balance FROM public.financial_account_balances
    WHERE account_code='liability.user_wallet'
      AND owner_id='f6100000-0000-4000-8000-000000000001'),
  5000::bigint,
  'Per-account balance view reflects the Campus Wallet liability'
);
-- Gear rental escrow uses a separate subledger liability per rental.
INSERT INTO public.listings (id,seller_id,title,category,price,status,university)
VALUES
  ('f6200000-0000-4000-8000-000000000005','f6100000-0000-4000-8000-000000000002','Gear rental standard fixture','Other',6000,'sold','University of Lagos'),
  ('f6200000-0000-4000-8000-000000000006','f6100000-0000-4000-8000-000000000002','Gear rental cancellation fixture','Other',3000,'sold','University of Lagos'),
  ('f6200000-0000-4000-8000-000000000007','f6100000-0000-4000-8000-000000000002','Gear rental dispute fixture','Other',10000,'sold','University of Lagos');

INSERT INTO public.gear_rentals (
  id,listing_id,borrower_id,lender_id,current_state,start_date,end_date,
  rental_fee_kobo,security_deposit_kobo,total_held_kobo,rental_status,settlement_lender_share_bps
) VALUES
  ('f6500000-0000-4000-8000-000000000001','f6200000-0000-4000-8000-000000000005',
   'f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002','funds_escrowed',
   current_date,current_date+1,4000,2000,6000,'active',NULL),
  ('f6500000-0000-4000-8000-000000000002','f6200000-0000-4000-8000-000000000006',
   'f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002','funds_escrowed',
   current_date,current_date+1,2000,1000,3000,'active',NULL),
  ('f6500000-0000-4000-8000-000000000003','f6200000-0000-4000-8000-000000000007',
   'f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002','funds_escrowed',
   current_date,current_date+1,7000,3000,10000,'active',6000);

INSERT INTO public.gear_rental_holds (
  rental_id,borrower_id,lender_id,rental_fee_kobo,security_deposit_kobo,total_held_kobo,status
) VALUES
  ('f6500000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002',4000,2000,6000,'held'),
  ('f6500000-0000-4000-8000-000000000002','f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002',2000,1000,3000,'held'),
  ('f6500000-0000-4000-8000-000000000003','f6100000-0000-4000-8000-000000000001','f6100000-0000-4000-8000-000000000002',7000,3000,10000,'held');

INSERT INTO public.financial_ledger (
  user_id,amount,currency,direction,source,reference_type,reference_id,idempotency_key,metadata
) VALUES
  ('f6100000-0000-4000-8000-000000000001',6000,'NGN','debit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000006','journal-fixture-gear-hold-1',
   '{"legacy_reason":"Campus Plug gear rental escrow hold","legacy_reference_id":"f6500000-0000-4000-8000-000000000001"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000002',4000,'NGN','credit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000007','journal-fixture-gear-fee-release',
   '{"legacy_reason":"Gear rental fee released after return inspection","legacy_reference_id":"f6500000-0000-4000-8000-000000000001"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000001',2000,'NGN','credit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000008','journal-fixture-gear-deposit-return',
   '{"legacy_reason":"Gear rental security deposit returned","legacy_reference_id":"f6500000-0000-4000-8000-000000000001"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000001',3000,'NGN','debit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000009','journal-fixture-gear-hold-2',
   '{"legacy_reason":"Campus Plug gear rental escrow hold","legacy_reference_id":"f6500000-0000-4000-8000-000000000002"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000001',3000,'NGN','credit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000010','journal-fixture-gear-cancel-refund',
   '{"legacy_reason":"Gear rental cancellation refund","legacy_reference_id":"f6500000-0000-4000-8000-000000000002"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000001',10000,'NGN','debit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000011','journal-fixture-gear-hold-3',
   '{"legacy_reason":"Campus Plug gear rental escrow hold","legacy_reference_id":"f6500000-0000-4000-8000-000000000003"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000002',6000,'NGN','credit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000012','journal-fixture-gear-dispute-lender',
   '{"legacy_reason":"Gear rental dispute settlement","legacy_reference_id":"f6500000-0000-4000-8000-000000000003"}'::jsonb),
  ('f6100000-0000-4000-8000-000000000001',4000,'NGN','credit','plug_credit_ledger','plug_credit_ledger','f6400000-0000-4000-8000-000000000013','journal-fixture-gear-dispute-borrower',
   '{"legacy_reason":"Gear rental dispute settlement refund","legacy_reference_id":"f6500000-0000-4000-8000-000000000003"}'::jsonb);

SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Campus Plug gear rental escrow hold'),
  3,'Gear rental holds create per-rental escrow liabilities'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Gear rental fee released after return inspection'),
  1,'Gear rental fee release credits the lender wallet'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Gear rental security deposit returned'),
  1,'Gear rental deposit return credits the borrower wallet'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Gear rental cancellation refund'),
  1,'Gear rental cancellation refunds the full held amount'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Gear rental dispute settlement'),
  1,'Gear rental dispute settlement credits the lender share'
);
SELECT is(
  (SELECT count(*)::integer FROM public.financial_journal_transactions
    WHERE metadata->>'legacy_reason'='Gear rental dispute settlement refund'),
  1,'Gear rental dispute refund credits the borrower share'
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
  $sql$ UPDATE public.financial_journal_entries SET debit=debit+1
      WHERE id=(
        SELECT e.id FROM public.financial_journal_entries e
        JOIN public.financial_journal_transactions t ON t.id=e.journal_transaction_id
        WHERE t.idempotency_key='paystack-escrow-funded:f6300000-0000-4000-8000-000000000001'
        ORDER BY e.id LIMIT 1
      ) $sql$,
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

SELECT ok(
  (SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid='public.financial_journal_entries'::regclass),
  'Journal entry table has row-level security enabled'
);
SELECT throws_ok(
  $sql$ SELECT public.post_financial_journal_transaction(
    'paystack.payout.success','seller_payout_transfers','payout_reference','f6300000-0000-4000-8000-000000000001',
    'paystack-payout:cp_tr_journalfixture0001:success',
    jsonb_build_array(
      jsonb_build_object('account_id',(
        SELECT id FROM public.financial_accounts WHERE account_code='liability.seller_payable' AND owner_id='f6100000-0000-4000-8000-000000000002' LIMIT 1
      ),'debit',9999,'credit',0),
      jsonb_build_object('account_id',(
        SELECT id FROM public.financial_accounts WHERE account_code='asset.paystack_clearing' AND owner_id IS NULL LIMIT 1
      ),'debit',0,'credit',9999)
    ),'{}'::jsonb
  ) $sql$,
  'P0001',
  'Journal idempotency key reused with a different financial payload',
  'A repeated idempotency key cannot post a different journal payload'
);
SELECT is(
  has_function_privilege('service_role','public.record_financial_ledger_entry(uuid,bigint,text,text,text,text,uuid,text,jsonb)','EXECUTE'),
  false,'Service role cannot bypass the PlugCredit ledger trigger with direct compatibility writes'
);
SELECT is(
  has_function_privilege('service_role','public.post_financial_journal_transaction(text,text,text,uuid,text,jsonb,jsonb)','EXECUTE'),
  false,'Service role cannot post arbitrary double-entry journal transactions'
);
SELECT is(
  has_table_privilege('service_role','public.financial_ledger','INSERT'),
  false,'Service role cannot bypass the trusted PlugCredit-to-ledger writer'
);
SELECT * FROM finish();
ROLLBACK;
