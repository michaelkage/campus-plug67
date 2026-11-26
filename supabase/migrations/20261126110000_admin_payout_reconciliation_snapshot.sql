-- Extend the read-only financial operations snapshot with Paystack seller payout state
-- and immutable operator audit history. The mutation endpoint remains separate.
-- Milestone 17: read-only financial operations and reconciliation workbench.
-- All queues are derived from immutable provider events and journal postings.
-- This RPC intentionally performs no settlement, refund, payout or ledger writes.

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
        WHERE t.refund_status IN ('failed','needs-attention')
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
        SELECT count(*) FROM public.seller_payout_transfers p
        WHERE p.status = 'needs_attention'
           OR (p.status = 'processing' AND p.lease_expires_at <= now())
           OR (p.status = 'pending' AND p.updated_at <= now() - interval '10 minutes')
      ),
      'payout_inflight', (
        SELECT count(*) FROM public.seller_payout_transfers p
        WHERE p.status IN ('processing','pending')
      ),
      'payout_reversals_24h', (
        SELECT count(*) FROM public.seller_payout_transfers p
        WHERE p.status = 'reversed' AND p.updated_at >= now() - interval '24 hours'
      )
    ),
    'refund_attention', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC)
      FROM (
        SELECT t.id, t.buyer_id, t.seller_id, t.amount AS amount_kobo,
               t.status, t.refund_status, t.paystack_ref, t.paystack_refund_id,
               t.refund_failure_reason, t.refund_initiated_at, t.updated_at
        FROM public.transactions t
        WHERE t.refund_status IN ('failed','needs-attention')
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
    'payout_queue', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.updated_at ASC)
      FROM (
        SELECT p.id AS transfer_id, p.transaction_id, p.seller_id,
               p.reference, p.amount_kobo, p.currency, p.status,
               p.provider_status, p.attempt_number, p.submission_attempts,
               p.created_at, p.updated_at, p.last_reconciled_at, p.lease_expires_at,
               r.bank_name, r.account_last4
        FROM public.seller_payout_transfers p
        JOIN public.seller_payout_recipients r ON r.id = p.recipient_id
        WHERE p.status IN ('processing','pending','needs_attention')
        ORDER BY p.updated_at ASC
        LIMIT v_limit
      ) x
    ), '[]'::jsonb),
    'payout_operator_audit', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
      FROM (
        SELECT a.id, a.transfer_id, a.transaction_id, t.reference,
               a.operator_id, COALESCE(op.full_name, 'Platform admin') AS operator_name,
               a.action, a.note, a.support_ticket, a.provider_status,
               a.provider_http_status, a.before_status, a.after_status,
               a.provider_verified_at, a.created_at
        FROM public.seller_payout_operator_audit a
        JOIN public.seller_payout_transfers t ON t.id = a.transfer_id
        LEFT JOIN public.profiles op ON op.id = a.operator_id
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
  'Platform-admin-only read model for payment/refund exceptions, payout reconciliation, operator audit, journal gaps and trial-balance integrity. It performs no financial mutations.';
