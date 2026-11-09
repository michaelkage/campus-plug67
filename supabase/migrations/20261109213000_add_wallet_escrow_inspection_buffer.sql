-- Buyer-confirmed handoff is provisional. Campus Wallet remains held for a
-- two-hour inspection window; only the database worker can settle it.
CREATE INDEX IF NOT EXISTS transactions_wallet_inspection_due_idx
  ON public.transactions (auto_release_at, id)
  WHERE status = 'release_requested'
    AND payment_method = 'campus_wallet';

CREATE OR REPLACE FUNCTION public.resolve_wallet_micro_escrow(
  p_transaction_id uuid,
  p_action text,
  p_qr_secret text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_user uuid := auth.uid();
  v_tx public.transactions%ROWTYPE;
  v_listing_id uuid;
  v_inspection_expires_at timestamptz;
BEGIN
  SELECT * INTO v_hold
    FROM public.wallet_escrow_holds
   WHERE transaction_id = p_transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet escrow not found'; END IF;
  IF v_user IS NULL OR (v_user <> v_hold.buyer_id AND v_user <> v_hold.seller_id) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF v_hold.status <> 'held' THEN RAISE EXCEPTION 'Wallet escrow already resolved'; END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = v_hold.transaction_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet escrow transaction not found'; END IF;
  IF COALESCE(v_tx.payment_method, '') <> 'campus_wallet' THEN
    RAISE EXCEPTION 'Wallet escrow transaction payment method mismatch';
  END IF;
  IF v_tx.buyer_id <> v_hold.buyer_id
     OR v_tx.seller_id <> v_hold.seller_id
     OR v_tx.amount <> v_hold.amount_kobo THEN
    RAISE EXCEPTION 'Wallet escrow participant or amount mismatch';
  END IF;

  v_listing_id := v_tx.listing_id;

  IF p_action = 'initiate_meetup' THEN
    IF v_user <> v_hold.seller_id THEN RAISE EXCEPTION 'Only the seller can initiate the wallet meetup'; END IF;
    IF v_tx.status <> 'locked' THEN RAISE EXCEPTION 'Wallet meetup can only start from locked state'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.listings WHERE id = v_listing_id AND status = 'reserved') THEN
      RAISE EXCEPTION 'Wallet escrow listing is not reserved';
    END IF;

    PERFORM set_config('app.escrow_transition', 'true', true);
    UPDATE public.transactions
       SET status = 'meetup_initiated',
           meetup_initiated_at = COALESCE(meetup_initiated_at, now())
     WHERE id = v_tx.id;

  ELSIF p_action = 'release' THEN
    IF v_user <> v_hold.buyer_id THEN RAISE EXCEPTION 'Only the buyer can confirm the Campus Wallet handoff'; END IF;
    IF v_tx.status <> 'meetup_initiated' THEN
      IF v_tx.status = 'release_requested' THEN
        RETURN jsonb_build_object(
          'success', true, 'status', 'inspection_pending',
          'transaction_id', v_tx.id, 'inspection_expires_at', v_tx.auto_release_at,
          'already_confirmed', true
        );
      END IF;
      RAISE EXCEPTION 'Wallet escrow is not ready for buyer confirmation';
    END IF;
    IF v_tx.meetup_initiated_at IS NULL
       OR v_tx.meetup_initiated_at > now() - interval '24 hours' THEN
      RAISE EXCEPTION '24-hour release gate has not elapsed';
    END IF;
    IF v_tx.buyer_arrived IS DISTINCT FROM true
       OR v_tx.buyer_safe_zone_id IS NULL
       OR v_tx.mobile_release_ready_at IS NULL
       OR v_tx.mobile_release_ready_at < now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'Fresh buyer Safe Swap Zone verification is required';
    END IF;
    IF v_tx.seller_arrived IS DISTINCT FROM true
       OR v_tx.seller_safe_zone_id IS NULL
       OR v_tx.seller_safe_zone_id IS DISTINCT FROM v_tx.buyer_safe_zone_id
       OR v_tx.seller_location_captured_at IS NULL
       OR v_tx.seller_location_captured_at < now() - interval '30 minutes' THEN
      RAISE EXCEPTION 'Seller must verify arrival in the same Safe Swap Zone within 30 minutes';
    END IF;
    IF p_qr_secret IS NULL
       OR COALESCE(v_tx.qr_secret, v_tx.release_code) IS NULL
       OR p_qr_secret IS DISTINCT FROM COALESCE(v_tx.qr_secret, v_tx.release_code) THEN
      RAISE EXCEPTION 'Invalid release credential';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.listings WHERE id = v_listing_id AND status = 'reserved') THEN
      RAISE EXCEPTION 'Wallet escrow listing is not reserved';
    END IF;

    v_inspection_expires_at := now() + interval '2 hours';
    PERFORM set_config('app.escrow_transition', 'true', true);
    UPDATE public.transactions
       SET status = 'release_requested',
           release_requested_at = now(),
           auto_release_at = v_inspection_expires_at,
           handshake_receipt_buffer = now(),
           payout_status = 'not_applicable'
     WHERE id = v_tx.id;

    RETURN jsonb_build_object(
      'success', true,
      'status', 'inspection_pending',
      'transaction_id', v_tx.id,
      'inspection_started_at', now(),
      'inspection_expires_at', v_inspection_expires_at,
      'funds_released', false
    );

  ELSIF p_action = 'refund' THEN
    IF v_user <> v_hold.buyer_id THEN RAISE EXCEPTION 'Only the buyer can request a wallet refund'; END IF;
    IF v_tx.status <> 'locked' THEN RAISE EXCEPTION 'Wallet refund is only available before meetup initiation'; END IF;

    PERFORM set_config('app.escrow_transition', 'true', true);
    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES (v_hold.buyer_id, v_hold.amount_kobo, 'Campus Wallet micro-escrow refund', v_hold.transaction_id);

    UPDATE public.wallet_escrow_holds
       SET status = 'refunded', resolved_at = now()
     WHERE id = v_hold.id AND status = 'held';

    UPDATE public.transactions
       SET status = 'cancelled', payout_status = 'not_applicable'
     WHERE id = v_hold.transaction_id;

    UPDATE public.listings AS l
       SET status = 'active', updated_at = now()
     WHERE l.id = v_listing_id
       AND l.status = 'reserved'
       AND NOT EXISTS (
         SELECT 1 FROM public.transactions AS other
          WHERE other.listing_id = l.id
            AND other.id <> v_tx.id
            AND other.status IN ('pending', 'locked', 'meetup_initiated', 'release_requested', 'disputed')
       );
  ELSE
    RAISE EXCEPTION 'Invalid wallet escrow action';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'status', CASE WHEN p_action = 'initiate_meetup' THEN 'meetup_initiated' ELSE p_action END,
    'transaction_id', v_tx.id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_wallet_micro_escrow(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid, text, text) TO authenticated;

-- The legacy AFTER trigger creates a 48-hour scheduled job and copy. Rewrite
-- those presentation records for Campus Wallet only; the database cron below
-- is the authoritative two-hour settlement mechanism.
CREATE OR REPLACE FUNCTION public.sync_wallet_inspection_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.payment_method = 'campus_wallet'
     AND NEW.status = 'release_requested'
     AND OLD.status IS DISTINCT FROM 'release_requested' THEN
    UPDATE public.scheduled_jobs
       SET run_at = NEW.auto_release_at
     WHERE entity_id = NEW.id
       AND type = 'auto_release'
       AND NOT executed;

    UPDATE public.notifications
       SET body = 'Handoff confirmed. Funds remain protected for a two-hour inspection window. File a dispute before it ends if you find a problem.',
           data = COALESCE(data, '{}'::jsonb) || jsonb_build_object(
             'inspection_expires_at', NEW.auto_release_at,
             'inspection_hours', 2,
             'funds_released', false
           )
     WHERE type = 'release_requested'
       AND data ->> 'transaction_id' = NEW.id::text
       AND user_id IN (NEW.buyer_id, NEW.seller_id);
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS wallet_inspection_schedule ON public.transactions;
CREATE TRIGGER wallet_inspection_schedule
AFTER UPDATE OF status ON public.transactions
FOR EACH ROW
EXECUTE FUNCTION public.sync_wallet_inspection_schedule();

REVOKE ALL ON FUNCTION public.sync_wallet_inspection_schedule() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.settle_due_wallet_inspections(p_limit integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_candidate record;
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_processed integer := 0;
  v_skipped integer := 0;
  v_error text;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);
BEGIN
  IF current_user <> 'postgres'
     AND COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  FOR v_candidate IN
    SELECT h.id AS hold_id, h.transaction_id
      FROM public.wallet_escrow_holds h
      JOIN public.transactions t ON t.id = h.transaction_id
     WHERE h.status = 'held'
       AND t.payment_method = 'campus_wallet'
       AND t.status = 'release_requested'
       AND t.auto_release_at IS NOT NULL
       AND t.auto_release_at <= now()
     ORDER BY t.auto_release_at, t.id
     FOR UPDATE OF h SKIP LOCKED
     LIMIT v_limit
  LOOP
    BEGIN
      SELECT * INTO v_hold
        FROM public.wallet_escrow_holds
       WHERE id = v_candidate.hold_id
       FOR UPDATE;
      SELECT * INTO v_tx
        FROM public.transactions
       WHERE id = v_candidate.transaction_id
       FOR UPDATE;

      IF NOT FOUND
         OR v_hold.status <> 'held'
         OR v_tx.status <> 'release_requested'
         OR v_tx.payment_method <> 'campus_wallet'
         OR v_tx.auto_release_at IS NULL
         OR v_tx.auto_release_at > now()
         OR v_hold.buyer_id <> v_tx.buyer_id
         OR v_hold.seller_id <> v_tx.seller_id
         OR v_hold.amount_kobo <> v_tx.amount THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM public.plug_credit_ledger debit
         WHERE debit.reference_id = v_tx.id
           AND debit.user_id = v_tx.buyer_id
           AND debit.amount = -v_tx.amount
           AND debit.reason = 'Campus Wallet escrow hold'
      ) THEN
        RAISE EXCEPTION 'Original Campus Wallet debit could not be verified';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM public.listings
         WHERE id = v_tx.listing_id AND status = 'reserved'
      ) THEN
        RAISE EXCEPTION 'Reserved listing could not be verified';
      END IF;

      PERFORM 1 FROM public.profiles
       WHERE id = v_tx.seller_id
       FOR UPDATE;

      PERFORM set_config('app.escrow_transition', 'true', true);
      INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
      VALUES (
        v_hold.seller_id,
        v_hold.amount_kobo,
        'Campus Wallet micro-escrow release',
        v_tx.id
      );

      UPDATE public.transactions
         SET status = 'released',
             released_at = now(),
             completed_at = now(),
             payout_status = 'paid',
             payout_failure_reason = NULL
       WHERE id = v_tx.id
         AND status = 'release_requested';

      IF NOT FOUND THEN RAISE EXCEPTION 'Transaction state changed during settlement'; END IF;

      v_processed := v_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error = MESSAGE_TEXT;
      RAISE WARNING 'Wallet inspection settlement skipped for transaction %: %',
        v_candidate.transaction_id, v_error;
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', v_processed, 'skipped', v_skipped);
END;
$function$;

REVOKE ALL ON FUNCTION public.settle_due_wallet_inspections(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_due_wallet_inspections(integer) TO service_role;

DO $schedule$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id
    FROM cron.job
   WHERE jobname = 'campus-wallet-inspection-settlement'
   LIMIT 1;
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;
  PERFORM cron.schedule(
    'campus-wallet-inspection-settlement',
    '* * * * *',
    'SELECT public.settle_due_wallet_inspections(100);'
  );
END;
$schedule$;
