-- READ-ONLY reconciliation for Campus Plug's double-entry journal.
-- Expected: every journal header has balanced lines; every supported wallet,
-- Paystack escrow, refund and payout event has its deterministic posting.

-- 1) Any imbalance is a hard accounting defect.
SELECT t.id, t.event_type, t.idempotency_key,
       COALESCE(sum(e.debit),0)::bigint AS debits,
       COALESCE(sum(e.credit),0)::bigint AS credits
FROM public.financial_journal_transactions t
LEFT JOIN public.financial_journal_entries e ON e.journal_transaction_id = t.id
GROUP BY t.id,t.event_type,t.idempotency_key
HAVING COALESCE(sum(e.debit),0) <> COALESCE(sum(e.credit),0)
    OR count(e.id) < 2;

-- 2) Journal headers whose entries affect fewer than two distinct accounts.
SELECT t.id,t.event_type,t.idempotency_key,count(DISTINCT e.account_id) account_count
FROM public.financial_journal_transactions t
JOIN public.financial_journal_entries e ON e.journal_transaction_id=t.id
GROUP BY t.id,t.event_type,t.idempotency_key
HAVING count(DISTINCT e.account_id) < 2;

-- 3) Supported compatibility wallet rows without a double-entry posting.
SELECT f.id,f.user_id,f.amount,f.direction,f.source,
       f.metadata->>'legacy_reason' AS legacy_reason
FROM public.financial_ledger f
LEFT JOIN public.financial_journal_transactions j
  ON j.idempotency_key='financial-ledger:' || f.id::text
WHERE f.source='plug_credit_ledger'
  AND f.metadata->>'legacy_reason' IN (
    'Campus Wallet funding',
    'Campus Wallet escrow hold',
    'Campus Wallet micro-escrow release',
    'Campus Wallet micro-escrow refund'
  )
  AND j.id IS NULL
ORDER BY f.created_at,f.id;

-- 4) Paystack escrow funding missing from the journal.
SELECT t.id,t.buyer_id,t.seller_id,t.amount,t.status,t.payment_verified
FROM public.transactions t
LEFT JOIN public.financial_journal_transactions j
  ON j.idempotency_key='paystack-escrow-funded:' || t.id::text
WHERE t.payment_verified IS TRUE
  AND COALESCE(t.payment_method,'paystack') <> 'campus_wallet'
  AND j.id IS NULL;

-- 5) Released Paystack transactions missing seller-payable recognition.
SELECT t.id,t.seller_id,t.amount,t.status,t.payout_status
FROM public.transactions t
LEFT JOIN public.financial_journal_transactions j
  ON j.idempotency_key='paystack-escrow-released:' || t.id::text
WHERE t.payment_verified IS TRUE
  AND COALESCE(t.payment_method,'paystack') <> 'campus_wallet'
  AND t.status IN ('released','completed')
  AND j.id IS NULL;

-- 6) Processed Paystack refunds missing a journal event.
SELECT t.id,t.paystack_ref,t.paystack_refund_id,t.amount,t.refund_status
FROM public.transactions t
LEFT JOIN public.financial_journal_transactions j
  ON j.idempotency_key='paystack-escrow-refunded:' || t.id::text
WHERE t.payment_verified IS TRUE
  AND COALESCE(t.payment_method,'paystack') <> 'campus_wallet'
  AND t.refund_status='processed'
  AND j.id IS NULL;

-- 7) Successful and reversed seller transfers must each have both their
-- original success posting and, when reversed, the compensating posting.
SELECT p.id,p.transaction_id,p.reference,p.status,p.amount_kobo,
       CASE
         WHEN success_journal.id IS NULL THEN 'missing_success_posting'
         WHEN p.status='reversed' AND reversal_journal.id IS NULL THEN 'missing_reversal_posting'
       END AS anomaly
FROM public.seller_payout_transfers p
LEFT JOIN public.financial_journal_transactions success_journal
  ON success_journal.idempotency_key='paystack-payout:' || p.reference || ':success'
LEFT JOIN public.financial_journal_transactions reversal_journal
  ON reversal_journal.idempotency_key='paystack-payout:' || p.reference || ':reversed'
WHERE p.status IN ('success','reversed')
  AND (success_journal.id IS NULL OR (p.status='reversed' AND reversal_journal.id IS NULL))
ORDER BY p.created_at,p.id;

-- 8) Wallet reasons not yet mapped to a double-entry counterpart require
-- explicit accounting design; they are never silently posted to suspense.
SELECT metadata->>'legacy_reason' AS legacy_reason,count(*) AS unposted_rows,
       sum(amount)::bigint AS amount_total
FROM public.financial_ledger f
WHERE f.source='plug_credit_ledger'
  AND metadata->>'legacy_reason' NOT IN (
    'Campus Wallet funding',
    'Campus Wallet escrow hold',
    'Campus Wallet micro-escrow release',
    'Campus Wallet micro-escrow refund'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.financial_journal_transactions j
    WHERE j.idempotency_key='financial-ledger:' || f.id::text
  )
GROUP BY metadata->>'legacy_reason'
ORDER BY legacy_reason;

-- 9) User-wallet journal balance vs the compatibility balance projection.
-- Positive liability balance means Campus Plug owes the user that amount.
WITH wallet_accounts AS (
  SELECT a.id,a.owner_id
  FROM public.financial_accounts a
  WHERE a.account_code='liability.user_wallet'
), journal_wallets AS (
  SELECT a.owner_id,
         sum(e.credit-e.debit)::bigint AS journal_balance_kobo
  FROM wallet_accounts a
  JOIN public.financial_journal_entries e ON e.account_id=a.id
  GROUP BY a.owner_id
)
SELECT p.id AS user_id,
       COALESCE(p.plug_credit_balance,0)::bigint AS profile_balance_kobo,
       COALESCE(j.journal_balance_kobo,0)::bigint AS journal_balance_kobo,
       (COALESCE(p.plug_credit_balance,0)-COALESCE(j.journal_balance_kobo,0))::bigint AS difference_kobo
FROM public.profiles p
LEFT JOIN journal_wallets j ON j.owner_id=p.id
WHERE COALESCE(p.plug_credit_balance,0) <> COALESCE(j.journal_balance_kobo,0)
ORDER BY p.id;

-- 10) Trial balance must be zero.
SELECT * FROM public.financial_journal_trial_balance WHERE imbalance <> 0;
