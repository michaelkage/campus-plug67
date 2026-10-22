-- Defense in depth: one wallet ledger effect per reference and operation.
-- The funding reference_id is the UUID wallet_funding_intents.id, not Paystack's text reference.
-- Fail with actionable diagnostics before index creation if legacy duplicates exist.
DO $$
DECLARE
  v_duplicate_groups bigint;
  v_examples text;
BEGIN
  SELECT count(*)
    INTO v_duplicate_groups
    FROM (
      SELECT reference_id, reason
        FROM public.plug_credit_ledger
       WHERE reason IN (
         'Campus Wallet funding',
         'Campus Wallet escrow hold',
         'Campus Wallet micro-escrow release',
         'Campus Wallet micro-escrow refund'
       )
       GROUP BY reference_id, reason
      HAVING count(*) > 1
    ) duplicates;

  IF v_duplicate_groups > 0 THEN
    SELECT string_agg(
             format('reference_id=%s reason=%L rows=%s',
                    reference_id, reason, row_count),
             '; ' ORDER BY row_count DESC, reason, reference_id
           )
      INTO v_examples
      FROM (
        SELECT reference_id, reason, count(*) AS row_count
          FROM public.plug_credit_ledger
         WHERE reason IN (
           'Campus Wallet funding',
           'Campus Wallet escrow hold',
           'Campus Wallet micro-escrow release',
           'Campus Wallet micro-escrow refund'
         )
         GROUP BY reference_id, reason
        HAVING count(*) > 1
         ORDER BY count(*) DESC, reason, reference_id
         LIMIT 5
      ) duplicate_examples;

    RAISE EXCEPTION
      'Cannot create wallet ledger idempotency index: found % duplicate reference/reason groups.',
      v_duplicate_groups
      USING HINT = format(
        'Review supabase/audits/wallet-ledger-integrity-readonly.sql, reconcile duplicate ledger effects safely, then retry. Sample groups: %s',
        coalesce(v_examples, 'no examples available')
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS plug_credit_ledger_wallet_reference_uidx
  ON public.plug_credit_ledger(reference_id, reason)
  WHERE reason IN (
    'Campus Wallet funding',
    'Campus Wallet escrow hold',
    'Campus Wallet micro-escrow release',
    'Campus Wallet micro-escrow refund'
  );

COMMENT ON INDEX public.plug_credit_ledger_wallet_reference_uidx IS
  'Prevents duplicate wallet funding, escrow holds, releases, or refunds for the same reference and operation.';
