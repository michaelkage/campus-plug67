-- Milestone 17: read-only financial operations and reconciliation workbench.
-- Queues combine provider event history, seller payout transfer state, operator audit and journal postings.
-- This RPC intentionally performs no settlement, refund, payout or ledger writes.

CREATE INDEX IF NOT EXISTS seller_payout_transfers_attention_idx
  ON public.seller_payout_transfers(status, updated_at DESC)
  WHERE status IN ('needs_attention','failed','blocked','rejected','abandoned','reversed');
CREATE INDEX IF NOT EXISTS seller_payout_operator_audit_created_idx
  ON public.seller_payout_operator_audit(created_at DESC);

CREATE OR REPLACE FUNCTION public.get_admin_financial_operations_snapshot(
  p_limit integer DEFAULT 30
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := COALESCE(p_limit, 30);
  v_result jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Platform admin required';
  END IF;
  IF v_limit < 1 OR v_limit > 100 THEN
    RAISE EXCEPTION 'Limit must be between 1 and 100';
  END IF;

  SELECT jsonb_build_object(
    'generated_at', now(),
    'counts', jsonb_build_object(
      'refund_attention', (
        SELECT count(*) FROM public.transactions t
        WHERE t.refund_status IN ('failed','needs-attention','needs_attention')
           OR (t.refund_status IN ('pending','processing')
               AND COALESCE(t.refund_initiated_at,t.updated_at,t.created_at) <= now() - interval '15 minutes')
      ),
      'failed_payment_events', (
        SELECT count(*) FROM public.payment_events p
        WHERE p.processing_status = 'failed'
      ),
      'missing_journal_postings', (
        SELECT count(*) FROM public.transactions t
        WHERE t.payment_verified IS TRUE
          AND COALESCE(t.payment_method,'paystack') <> 'campus_wallet'
          AND (
            NOT EXISTS (
              SELECT 1 FROM public.financial_journal_transactions j
              WHERE j.idempotency_key = 'paystack-escrow-funded:' || t.id::text
            )
            OR (t.status IN ('released','completed') AND NOT EXISTS (
              SELECT 1 FROM public.financial_journal_transactions j
              WHERE j.idempotency_key = 'paystack-escrow-released:' || t.id::text
            ))
            OR (t.refund_status = 'processed' AND NOT EXISTS (
              SELECT 1 FROM public.financial_journal_transactions j
              WHERE j.idempotency_key = 'paystack-escrow-refunded:' || t.id::text
            ))
            OR EXISTS (
              SELECT 1 FROM public.seller_payout_transfers p
              WHERE p.transaction_id = t.id AND p.status = 'success'
                AND NOT EXISTS (
                  SELECT 1 FROM public.financial_journal_transactions j
                  WHERE j.idempotency_key = 'paystack-payout:' || p.reference || ':success'
                )
            )
            OR EXISTS (
              SELECT 1 FROM public.seller_payout_transfers p
              WHERE p.transaction_id = t.id AND p.status = 'reversed'
                AND NOT EXISTS (
                  SELECT 1 FROM public.financial_journal_transactions j
                  WHERE j.idempotency_key = 'paystack-payout:' || p.reference || ':success'
                )
            )
            OR EXISTS (
              SELECT 1 FROM public.seller_payout_transfers p
              WHERE p.transaction_id = t.id AND p.status = 'reversed'
                AND NOT EXISTS (
                  SELECT 1 FROM public.financial_journal_transactions j
                  WHERE j.idempotency_key = 'paystack-payout:' || p.reference || ':reversed'
                )
            )
          )
      ),
      'unmirrored_wallet_entries', (
        SELECT count(*) FROM public.financial_ledger f
        WHERE f.source = 'plug_credit_ledger'
          AND f.reference_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'plug-credit-ledger:' || f.reference_id::text
          )
      ),
      'disputed_transactions', (
        SELECT count(*) FROM public.transactions WHERE status = 'disputed'
      ),
      'journal_balance_imbalances', (
        SELECT count(*) FROM public.financial_journal_trial_balance WHERE imbalance <> 0
      ),
      'payout_attention', (
        SELECT count(*)
        FROM public.seller_payout_transfers p
        JOIN public.transactions t ON t.id = p.transaction_id
        WHERE (
          p.status IN ('needs_attention','blocked','rejected','abandoned','reversed')
          OR (p.status = 'failed' AND t.payout_status = 'failed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.seller_payout_transfers newer
          WHERE newer.transaction_id = p.transaction_id
            AND newer.attempt_number > p.attempt_number
        )
      ),
      'stale_payout_attempts', (
        SELECT count(*) FROM public.seller_payout_transfers p
        WHERE p.status IN ('processing','pending')
          AND GREATEST(p.updated_at, COALESCE(p.last_reconciled_at,p.created_at)) <= now() - interval '15 minutes'
          AND (p.lease_expires_at IS NULL OR p.lease_expires_at <= now())
      ),
      'payout_operator_audits', (
        SELECT count(*) FROM public.seller_payout_operator_audit
      )
    ),
    'refund_attention', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC)
      FROM (
        SELECT t.id, t.buyer_id, t.seller_id, t.amount AS amount_kobo,
               t.status, t.refund_status, t.paystack_ref, t.paystack_refund_id,
               t.refund_failure_reason, t.refund_initiated_at, t.updated_at
        FROM public.transactions t
        WHERE t.refund_status IN ('failed','needs-attention','needs_attention')
           OR (t.refund_status IN ('pending','processing')
               AND COALESCE(t.refund_initiated_at,t.updated_at,t.created_at) <= now() - interval '15 minutes')
        ORDER BY t.updated_at DESC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'payment_failures', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.received_at DESC)
      FROM (
        SELECT p.provider, p.event_id, p.event_type, p.reference,
               p.transaction_id, p.amount, p.currency, p.processing_status,
               p.failure_reason, p.received_at
        FROM public.payment_events p
        WHERE p.processing_status = 'failed'
        ORDER BY p.received_at DESC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'missing_journal', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
      FROM (
        SELECT t.id AS transaction_id, 'paystack_funding_not_posted'::text AS issue,
               t.amount AS amount_kobo, t.status, t.paystack_ref, t.created_at
        FROM public.transactions t
        WHERE t.payment_verified IS TRUE
          AND COALESCE(t.payment_method,'paystack') <> 'campus_wallet'
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'paystack-escrow-funded:' || t.id::text
          )
        UNION ALL
        SELECT t.id, 'paystack_release_not_posted',
               t.amount, t.status, t.paystack_ref, t.created_at
        FROM public.transactions t
        WHERE t.payment_verified IS TRUE
          AND COALESCE(t.payment_method,'paystack') <> 'campus_wallet'
          AND t.status IN ('released','completed')
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'paystack-escrow-released:' || t.id::text
          )
        UNION ALL
        SELECT t.id, 'paystack_refund_not_posted',
               t.amount, t.status, t.paystack_ref, t.created_at
        FROM public.transactions t
        WHERE t.payment_verified IS TRUE
          AND COALESCE(t.payment_method,'paystack') <> 'campus_wallet'
          AND t.refund_status = 'processed'
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'paystack-escrow-refunded:' || t.id::text
          )
        UNION ALL
        SELECT p.transaction_id, 'paystack_payout_success_not_posted',
               p.amount_kobo, p.status, p.reference, p.created_at
        FROM public.seller_payout_transfers p
        WHERE p.status = 'success'
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'paystack-payout:' || p.reference || ':success'
          )
        UNION ALL
        SELECT p.transaction_id, 'paystack_payout_reversal_success_not_posted',
               p.amount_kobo, p.status, p.reference, p.created_at
        FROM public.seller_payout_transfers p
        WHERE p.status = 'reversed'
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'paystack-payout:' || p.reference || ':success'
          )
        UNION ALL
        SELECT p.transaction_id, 'paystack_payout_reversal_not_posted',
               p.amount_kobo, p.status, p.reference, p.created_at
        FROM public.seller_payout_transfers p
        WHERE p.status = 'reversed'
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'paystack-payout:' || p.reference || ':reversed'
          )
        ORDER BY created_at DESC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'unmirrored_wallet_entries', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
      FROM (
        SELECT f.id AS ledger_entry_id, f.user_id, f.amount,
               f.currency, f.direction, f.reference_id, f.created_at
        FROM public.financial_ledger f
        WHERE f.source = 'plug_credit_ledger'
          AND f.reference_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.financial_journal_transactions j
            WHERE j.idempotency_key = 'plug-credit-ledger:' || f.reference_id::text
          )
        ORDER BY f.created_at DESC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'payout_attention', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC)
      FROM (
        SELECT p.id AS transfer_id, p.transaction_id, p.seller_id,
               p.attempt_number, p.reference, p.amount_kobo, p.status,
               p.failure_reason, p.provider_message, t.payout_status,
               p.created_at, p.updated_at
        FROM public.seller_payout_transfers p
        JOIN public.transactions t ON t.id = p.transaction_id
        WHERE (
          p.status IN ('needs_attention','blocked','rejected','abandoned','reversed')
          OR (p.status = 'failed' AND t.payout_status = 'failed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.seller_payout_transfers newer
          WHERE newer.transaction_id = p.transaction_id
            AND newer.attempt_number > p.attempt_number
        )
        ORDER BY p.updated_at DESC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'stale_payouts', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.updated_at ASC)
      FROM (
        SELECT p.id AS transfer_id, p.transaction_id, p.seller_id,
               p.attempt_number, p.reference, p.amount_kobo, p.status,
               p.provider_status, p.provider_message, p.created_at, p.updated_at
        FROM public.seller_payout_transfers p
        WHERE p.status IN ('processing','pending')
          AND GREATEST(p.updated_at, COALESCE(p.last_reconciled_at,p.created_at)) <= now() - interval '15 minutes'
          AND (p.lease_expires_at IS NULL OR p.lease_expires_at <= now())
        ORDER BY p.updated_at ASC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'payout_operator_audit', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
      FROM (
        SELECT a.id, a.transfer_id, a.transaction_id, a.operator_id,
               a.action, a.provider_reference, a.provider_http_status,
               a.note, a.created_at
        FROM public.seller_payout_operator_audit a
        ORDER BY a.created_at DESC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'journal_balance', COALESCE((
      SELECT jsonb_agg(to_jsonb(b))
      FROM public.financial_journal_trial_balance b
      WHERE b.imbalance <> 0
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_admin_financial_operations_snapshot(integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_admin_financial_operations_snapshot(integer)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_admin_financial_operations_snapshot(integer) IS
  'Platform-admin-only read model for payment/refund exceptions, seller payout attention and stale attempts, immutable operator recovery audit, missing journal postings, wallet mirror gaps and trial-balance imbalances. No financial mutations are performed.';
