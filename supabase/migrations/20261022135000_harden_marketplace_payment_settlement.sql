-- Make Paystack settlement atomic with listing eligibility and reject stale/ineligible purchases.
CREATE OR REPLACE FUNCTION public.process_paystack_success(
  p_webhook_id text,
  p_event_type text,
  p_reference text,
  p_amount bigint,
  p_transaction_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count int;
  webhook_row public.processed_webhooks%ROWTYPE;
  tx public.transactions%ROWTYPE;
  listing_status text;
  updated_count int;
BEGIN
  IF p_webhook_id IS NULL OR length(trim(p_webhook_id)) = 0
     OR p_event_type IS NULL OR length(trim(p_event_type)) = 0
     OR p_reference IS NULL OR length(trim(p_reference)) = 0
     OR p_amount IS NULL OR p_amount <= 0
     OR p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'Payment event is missing required fields';
  END IF;

  INSERT INTO public.processed_webhooks(webhook_id, event_type, processed)
  VALUES (p_webhook_id, p_event_type, false)
  ON CONFLICT (webhook_id) DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  IF inserted_count = 0 THEN
    SELECT * INTO webhook_row
      FROM public.processed_webhooks
     WHERE webhook_id = p_webhook_id
     FOR UPDATE;
    IF webhook_row.processed THEN
      RETURN jsonb_build_object('success', true, 'duplicate', true);
    END IF;
    IF webhook_row.event_type IS DISTINCT FROM p_event_type THEN
      RAISE EXCEPTION 'Payment reference was claimed by a different event type';
    END IF;
  END IF;

  SELECT * INTO tx FROM public.transactions WHERE id = p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found for payment'; END IF;
  IF tx.paystack_ref IS DISTINCT FROM p_reference THEN RAISE EXCEPTION 'Paystack reference mismatch'; END IF;
  IF tx.amount IS DISTINCT FROM p_amount THEN RAISE EXCEPTION 'Paystack amount mismatch'; END IF;

  -- Idempotent replay of an already-settled transaction is safe even if its
  -- listing has since changed. Every other non-pending state is ineligible.
  IF tx.status = 'locked' AND tx.payment_verified THEN
    UPDATE public.processed_webhooks SET processed = true WHERE webhook_id = p_webhook_id;
    RETURN jsonb_build_object('success', true, 'duplicate', true, 'transaction_id', tx.id);
  END IF;
  IF tx.status <> 'pending' OR COALESCE(tx.payment_verified, false) THEN
    RAISE EXCEPTION 'Transaction is not eligible for payment settlement';
  END IF;

  -- Serialize settlement with listing changes and do not lock escrow for an
  -- inactive/sold listing. The transaction remains pending for manual recovery.
  SELECT status INTO listing_status FROM public.listings WHERE id = tx.listing_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found for payment'; END IF;
  IF listing_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'Listing is no longer available for payment settlement';
  END IF;

  PERFORM set_config('app.escrow_transition', 'true', true);
  UPDATE public.transactions
     SET status = 'locked', payment_verified = true, locked_at = COALESCE(locked_at, now())
   WHERE id = tx.id AND status = 'pending' AND COALESCE(payment_verified, false) = false;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN RAISE EXCEPTION 'Transaction settlement lost a concurrent update'; END IF;

  UPDATE public.listings
     SET status = 'sold', updated_at = now()
   WHERE id = tx.listing_id AND status = 'active';
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN RAISE EXCEPTION 'Listing availability changed during settlement'; END IF;

  UPDATE public.processed_webhooks SET processed = true WHERE webhook_id = p_webhook_id;
  RETURN jsonb_build_object('success', true, 'duplicate', false, 'transaction_id', tx.id);
END;
$$;

REVOKE ALL ON FUNCTION public.process_paystack_success(text, text, text, bigint, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_paystack_success(text, text, text, bigint, uuid)
  TO service_role;
