-- READ-ONLY financial journal mirror audit.
-- The compatibility ledger remains the current wallet write interface.
-- Every PlugCredit row must have exactly one identical financial journal mirror.

-- 1) Missing mirror rows.
SELECT p.id AS plug_credit_ledger_id, p.user_id, p.amount, p.reason, p.reference_id
FROM public.plug_credit_ledger p
LEFT JOIN public.financial_ledger f
  ON f.user_id = p.user_id
 AND f.idempotency_key = 'plug-credit-ledger:' || p.id::text
WHERE f.id IS NULL
ORDER BY p.created_at, p.id;

-- 2) Conflicting mirror payloads.
SELECT p.id AS plug_credit_ledger_id, f.id AS financial_ledger_id,
       p.user_id, p.amount AS legacy_signed_amount,
       f.amount AS journal_absolute_amount, f.direction,
       p.reason, f.source, f.reference_type, f.reference_id
FROM public.plug_credit_ledger p
JOIN public.financial_ledger f
  ON f.user_id = p.user_id
 AND f.idempotency_key = 'plug-credit-ledger:' || p.id::text
WHERE f.amount <> abs(p.amount)
   OR f.currency <> 'NGN'
   OR f.direction <> CASE WHEN p.amount > 0 THEN 'credit' ELSE 'debit' END
   OR f.source <> 'plug_credit_ledger'
   OR f.reference_type <> 'plug_credit_ledger'
   OR f.reference_id <> p.id
   OR f.metadata->>'legacy_reason' IS DISTINCT FROM p.reason
   OR f.metadata->>'legacy_reference_id' IS DISTINCT FROM p.reference_id::text
ORDER BY p.created_at, p.id;

-- 3) Orphan mirror rows.
SELECT f.id, f.user_id, f.amount, f.direction, f.idempotency_key
FROM public.financial_ledger f
WHERE f.idempotency_key LIKE 'plug-credit-ledger:%'
  AND NOT EXISTS (
    SELECT 1 FROM public.plug_credit_ledger p
    WHERE p.id = f.reference_id
      AND p.user_id = f.user_id
  )
ORDER BY f.created_at, f.id;

-- 4) Summary. A zero anomaly count is required before cutover from the
-- compatibility writer to financial-ledger-first wallet operations.
SELECT
  (SELECT count(*) FROM public.plug_credit_ledger) AS legacy_rows,
  (SELECT count(*) FROM public.financial_ledger
    WHERE idempotency_key LIKE 'plug-credit-ledger:%') AS mirrored_rows,
  (SELECT count(*)
     FROM public.plug_credit_ledger p
     LEFT JOIN public.financial_ledger f
       ON f.user_id = p.user_id
      AND f.idempotency_key = 'plug-credit-ledger:' || p.id::text
    WHERE f.id IS NULL) AS missing_mirrors;
