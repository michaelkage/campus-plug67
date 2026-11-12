-- Preserve manual/OTP payout attention when Paystack sends later non-terminal updates.
-- This migration is append-only so already-applied payout foundation history is untouched.

CREATE OR REPLACE FUNCTION public.record_paystack_transfer(
  p_reference text,
  p_status text,
  p_amount bigint,
  p_currency text,
  p_recipient_code text,
  p_transfer_code text DEFAULT NULL,
  p_provider_transfer_id text DEFAULT NULL,
  p_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_transfer public.seller_payout_transfers%ROWTYPE;
  v_recipient public.seller_payout_recipients%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_status text := lower(COALESCE(p_status, ''));
  v_previous_status text;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF v_status NOT IN ('pending','success','failed','reversed','otp','needs_attention','abandoned','blocked','rejected','received') THEN
    RAISE EXCEPTION 'Unsupported Paystack transfer status';
  END IF;
  IF p_reference IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR upper(COALESCE(p_currency, '')) <> 'NGN'
     OR p_recipient_code IS NULL THEN
    RAISE EXCEPTION 'Paystack transfer event is missing required financial fields';
  END IF;

  SELECT * INTO v_transfer
    FROM public.seller_payout_transfers
   WHERE reference = p_reference
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown Paystack transfer reference'; END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = v_transfer.transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout transaction not found'; END IF;

  SELECT * INTO v_recipient
    FROM public.seller_payout_recipients
   WHERE id = v_transfer.recipient_id;
  IF NOT FOUND
     OR v_recipient.recipient_code <> p_recipient_code
     OR v_transfer.seller_id <> v_tx.seller_id
     OR v_transfer.amount_kobo <> p_amount
     OR v_tx.amount <> p_amount
     OR v_transfer.currency <> upper(p_currency)
     OR v_tx.payment_verified IS DISTINCT FROM true
     OR v_tx.status NOT IN ('released','completed')
     OR COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
    RAISE EXCEPTION 'Paystack transfer does not match the approved escrow payout';
  END IF;

  v_previous_status := v_transfer.status;

  -- Once quarantined for OTP/manual review, non-terminal provider updates
  -- must never erase the operator-visible attention state. Authoritative
  -- success/failure/reversal can still resolve the attempt below.
  IF v_previous_status = 'needs_attention'
     AND v_status IN ('pending','received') THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate_or_stale', true,
      'status', v_previous_status,
      'same_status', false
    );
  END IF;

  -- Provider events can be delivered late or out of order. Never downgrade a
  -- conclusive state, except that a real reversal must undo a prior success.
  IF v_previous_status = 'success' AND v_status <> 'reversed' THEN
    RETURN jsonb_build_object('success', true, 'duplicate_or_stale', true, 'status', v_previous_status);
  END IF;
  IF v_previous_status IN ('failed','reversed','abandoned','blocked','rejected')
     OR (
       v_previous_status = 'needs_attention'
       AND v_status IN ('otp','needs_attention')
       AND (p_transfer_code IS NULL OR p_transfer_code IS NOT DISTINCT FROM v_transfer.provider_transfer_code)
       AND (p_provider_transfer_id IS NULL OR p_provider_transfer_id IS NOT DISTINCT FROM v_transfer.provider_transfer_id)
     ) THEN
    RETURN jsonb_build_object(
      'success', true,
      'duplicate_or_stale', true,
      'status', v_previous_status,
      'same_status', v_status = v_previous_status
    );
  END IF;

  IF v_status = 'success' THEN
    UPDATE public.seller_payout_transfers
       SET status = 'success',
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = left(p_message, 500),
           failure_reason = NULL,
           lease_expires_at = NULL,
           completed_at = COALESCE(completed_at, now()),
           updated_at = now()
     WHERE id = v_transfer.id;

    UPDATE public.transactions
       SET payout_status = 'paid',
           payout_reference = v_transfer.reference,
           payout_failure_reason = NULL
     WHERE id = v_tx.id;

    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES (
      v_tx.seller_id,
      'seller_payout_success',
      '🏦 Bank transfer successful',
      'Paystack marked your ₦' || to_char(v_tx.amount / 100.0, 'FM999,999,999,990.00') ||
        ' transfer successful. Your bank may take additional time to post the funds.',
      jsonb_build_object('transaction_id', v_tx.id, 'payout_reference', v_transfer.reference, 'payout_status', 'paid')
    );
  ELSIF v_status = 'reversed' THEN
    UPDATE public.seller_payout_transfers
       SET status = 'reversed',
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = left(p_message, 500),
           failure_reason = left(COALESCE(p_message, 'Paystack reversed the transfer'), 500),
           lease_expires_at = NULL,
           completed_at = COALESCE(completed_at, now()),
           earnings_reversed_at = CASE WHEN v_previous_status = 'success' THEN COALESCE(earnings_reversed_at, now()) ELSE earnings_reversed_at END,
           updated_at = now()
     WHERE id = v_transfer.id;

    IF v_previous_status = 'success' AND v_transfer.earnings_reversed_at IS NULL THEN
      UPDATE public.profiles
         SET total_earnings = GREATEST(COALESCE(total_earnings, 0) - v_tx.amount, 0)
       WHERE id = v_tx.seller_id;
    END IF;

    UPDATE public.transactions
       SET payout_status = 'failed',
           payout_reference = v_transfer.reference,
           payout_failure_reason = left('Paystack transfer reversed: ' || COALESCE(p_message, 'funds returned to merchant balance'), 500)
     WHERE id = v_tx.id;

    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES (
      v_tx.seller_id,
      'seller_payout_reversed',
      '⚠️ Bank transfer reversed',
      'Paystack reversed the bank transfer for this sale. The payout is no longer complete and needs another attempt or support review.',
      jsonb_build_object('transaction_id', v_tx.id, 'payout_reference', v_transfer.reference, 'payout_status', 'failed')
    );
  ELSIF v_status IN ('failed','abandoned','blocked','rejected') THEN
    UPDATE public.seller_payout_transfers
       SET status = v_status,
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = left(p_message, 500),
           failure_reason = left(COALESCE(p_message, 'Paystack transfer did not complete'), 500),
           lease_expires_at = NULL,
           completed_at = now(),
           updated_at = now()
     WHERE id = v_transfer.id;

    UPDATE public.transactions
       SET payout_status = 'failed',
           payout_reference = v_transfer.reference,
           payout_failure_reason = left(COALESCE(p_message, 'Paystack transfer ' || v_status), 500)
     WHERE id = v_tx.id;

    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES (
      v_tx.seller_id,
      'seller_payout_failed',
      '⚠️ Seller payout needs attention',
      'Your exchange is complete, but Paystack could not complete the bank transfer. The payout will be retried only after the provider reports a conclusive result.',
      jsonb_build_object('transaction_id', v_tx.id, 'payout_reference', v_transfer.reference, 'payout_status', 'failed')
    );
  ELSE
    UPDATE public.seller_payout_transfers
       SET status = CASE WHEN v_status IN ('otp','needs_attention') THEN 'needs_attention' ELSE 'pending' END,
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = left(p_message, 500),
           lease_expires_at = NULL,
           updated_at = now()
     WHERE id = v_transfer.id;

    UPDATE public.transactions
       SET payout_status = CASE
             WHEN v_status IN ('otp','needs_attention') THEN 'needs_attention'
             ELSE 'processing'
           END,
           payout_reference = v_transfer.reference,
           payout_failure_reason = CASE
             WHEN v_status = 'otp' THEN 'Paystack transfer requires merchant OTP approval'
             WHEN v_status = 'needs_attention' THEN 'Paystack requires manual review. Your bank payout is not yet confirmed.'
             ELSE NULL
           END
     WHERE id = v_tx.id;

    IF v_status IN ('otp','needs_attention') THEN
      INSERT INTO public.notifications(user_id, type, title, body, data)
      VALUES (
        v_tx.seller_id,
        'seller_payout_manual_review',
        '⚠️ Bank payout requires manual approval',
        CASE
          WHEN v_status = 'otp' THEN 'Paystack requires merchant OTP approval before this transfer can continue. Campus Plug will not attempt to bypass that approval.'
          ELSE 'The provider transfer details need manual review. Your seller payout remains unconfirmed.'
        END,
        jsonb_build_object('transaction_id', v_tx.id, 'payout_reference', v_transfer.reference, 'payout_status', 'needs_attention')
      );
    END IF;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', CASE WHEN v_status IN ('otp','needs_attention') THEN 'needs_attention' ELSE v_status END, 'transaction_id', v_tx.id);
END;
$function$;
