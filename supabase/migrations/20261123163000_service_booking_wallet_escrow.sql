-- Service booking escrow: accepted quotes are funded from Campus Wallet and
-- held until customer confirmation, an approved dispute resolution, or timeout.
ALTER TABLE public.gig_bookings
  DROP CONSTRAINT IF EXISTS gig_bookings_status_check;
ALTER TABLE public.gig_bookings
  ADD CONSTRAINT gig_bookings_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text, 'quoted'::text, 'confirmed'::text,
    'in_progress'::text, 'delivered'::text, 'disputed'::text,
    'completed'::text, 'cancelled'::text
  ]));

CREATE TABLE IF NOT EXISTS public.service_booking_escrows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES public.gig_bookings(id) ON DELETE RESTRICT,
  quote_id uuid NOT NULL UNIQUE REFERENCES public.service_booking_quotes(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  status text NOT NULL DEFAULT 'held'
    CHECK (status IN ('held','disputed','released','refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  auto_release_at timestamptz,
  resolved_at timestamptz,
  CONSTRAINT service_booking_escrows_parties_distinct CHECK (client_id <> seller_id)
);

CREATE INDEX IF NOT EXISTS service_booking_escrows_client_status_idx
  ON public.service_booking_escrows(client_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS service_booking_escrows_seller_status_idx
  ON public.service_booking_escrows(seller_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS service_booking_escrows_auto_release_idx
  ON public.service_booking_escrows(auto_release_at, booking_id)
  WHERE status = 'held' AND auto_release_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.service_booking_disputes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL UNIQUE REFERENCES public.gig_bookings(id) ON DELETE RESTRICT,
  escrow_id uuid NOT NULL UNIQUE REFERENCES public.service_booking_escrows(id) ON DELETE RESTRICT,
  opened_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 20 AND 5000),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolution text CHECK (resolution IN ('release_to_provider','refund_customer')),
  resolution_note text,
  resolved_by uuid REFERENCES public.profiles(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS service_booking_disputes_status_created_idx
  ON public.service_booking_disputes(status, created_at);

ALTER TABLE public.service_booking_escrows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_booking_disputes ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.service_booking_escrows, public.service_booking_disputes TO authenticated;
REVOKE ALL ON public.service_booking_escrows, public.service_booking_disputes
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.service_booking_escrows, public.service_booking_disputes TO authenticated;
GRANT ALL ON public.service_booking_escrows, public.service_booking_disputes TO service_role;

DROP POLICY IF EXISTS service_booking_escrows_participant_select ON public.service_booking_escrows;
CREATE POLICY service_booking_escrows_participant_select
  ON public.service_booking_escrows FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = client_id OR (SELECT auth.uid()) = seller_id);

DROP POLICY IF EXISTS service_booking_disputes_participant_select ON public.service_booking_disputes;
CREATE POLICY service_booking_disputes_participant_select
  ON public.service_booking_disputes FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.gig_bookings b
      WHERE b.id = booking_id
        AND ((SELECT auth.uid()) = b.client_id OR (SELECT auth.uid()) = b.seller_id)
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS plug_credit_ledger_service_booking_reference_uidx
  ON public.plug_credit_ledger(reference_id, reason)
  WHERE reason IN (
    'Service booking escrow hold',
    'Service booking escrow release',
    'Service booking escrow refund',
    'Service booking escrow auto-release',
    'Service booking dispute refund',
    'Service booking dispute release'
  );

-- Participants can read their own escrow/dispute records. All money/state writes
-- are performed by narrow SECURITY DEFINER RPCs.
REVOKE INSERT, UPDATE, DELETE ON public.service_booking_escrows,
  public.service_booking_disputes FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fund_gig_booking_escrow(p_booking_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_booking public.gig_bookings%ROWTYPE;
  v_quote public.service_booking_quotes%ROWTYPE;
  v_escrow public.service_booking_escrows%ROWTYPE;
  v_balance bigint;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_booking
    FROM public.gig_bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service booking not found'; END IF;
  IF v_actor <> v_booking.client_id THEN RAISE EXCEPTION 'Only the customer can fund this service booking'; END IF;

  SELECT * INTO v_escrow
    FROM public.service_booking_escrows
   WHERE booking_id = v_booking.id;
  IF FOUND THEN
    IF v_escrow.client_id <> v_booking.client_id
      OR v_escrow.seller_id <> v_booking.seller_id
      OR v_escrow.amount_kobo <> v_booking.amount THEN
      RAISE EXCEPTION 'Existing service escrow does not match the booking';
    END IF;
    IF v_escrow.status = 'held' THEN
      RETURN jsonb_build_object(
        'success', true, 'idempotent', true, 'escrow_id', v_escrow.id,
        'status', v_escrow.status, 'amount_kobo', v_escrow.amount_kobo,
        'auto_release_at', v_escrow.auto_release_at
      );
    END IF;
    RAISE EXCEPTION 'Service booking escrow has already been resolved';
  END IF;

  IF v_booking.status IS DISTINCT FROM 'confirmed' THEN
    RAISE EXCEPTION 'Accept the provider quote before funding the booking';
  END IF;

  SELECT * INTO v_quote
    FROM public.service_booking_quotes
   WHERE booking_id = v_booking.id
     AND status = 'accepted'
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'An accepted final quote is required'; END IF;
  IF v_quote.client_id <> v_booking.client_id
    OR v_quote.seller_id <> v_booking.seller_id
    OR v_quote.amount_kobo <> v_booking.amount THEN
    RAISE EXCEPTION 'Accepted quote does not match the booking parties or amount';
  END IF;

  PERFORM 1 FROM public.profiles WHERE id = v_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer wallet profile not found'; END IF;
  SELECT COALESCE(plug_credit_balance, 0)
    INTO v_balance
    FROM public.profiles
   WHERE id = v_actor;
  IF v_balance < v_quote.amount_kobo THEN RAISE EXCEPTION 'Insufficient Campus Wallet balance'; END IF;

  INSERT INTO public.service_booking_escrows(
    booking_id, quote_id, client_id, seller_id, amount_kobo
  ) VALUES (
    v_booking.id, v_quote.id, v_booking.client_id, v_booking.seller_id, v_quote.amount_kobo
  ) RETURNING * INTO v_escrow;

  INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
  VALUES(v_actor, -v_quote.amount_kobo, 'Service booking escrow hold', v_booking.id);

  INSERT INTO public.notifications(user_id, type, title, body, data)
  VALUES(v_booking.seller_id, 'service_escrow_funded', 'Service booking funded',
    'The customer funded the accepted quote. You can now start the service.',
    jsonb_build_object('booking_id', v_booking.id, 'escrow_id', v_escrow.id, 'amount_kobo', v_quote.amount_kobo));

  RETURN jsonb_build_object(
    'success', true, 'escrow_id', v_escrow.id, 'status', v_escrow.status,
    'amount_kobo', v_escrow.amount_kobo, 'wallet_balance_after', v_balance - v_quote.amount_kobo
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.transition_gig_booking(
  p_booking_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_booking public.gig_bookings%ROWTYPE;
  v_escrow public.service_booking_escrows%ROWTYPE;
  v_target_status text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_booking
    FROM public.gig_bookings
   WHERE id = p_booking_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;

  SELECT * INTO v_escrow
    FROM public.service_booking_escrows
   WHERE booking_id = v_booking.id
   FOR UPDATE;

  CASE p_action
    WHEN 'start' THEN
      IF v_actor <> v_booking.seller_id THEN RAISE EXCEPTION 'Only the provider can start the service'; END IF;
      IF v_booking.status IS DISTINCT FROM 'confirmed' THEN RAISE EXCEPTION 'Accept the final quote before starting work'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.service_booking_quotes
        WHERE booking_id = v_booking.id AND status = 'accepted'
      ) THEN RAISE EXCEPTION 'An accepted final quote is required'; END IF;
      IF v_escrow.id IS NULL OR v_escrow.status <> 'held' THEN
        RAISE EXCEPTION 'Customer must fund the service escrow before work starts';
      END IF;
      v_target_status := 'in_progress';

    WHEN 'deliver' THEN
      IF v_actor <> v_booking.seller_id THEN RAISE EXCEPTION 'Only the provider can mark the service delivered'; END IF;
      IF v_booking.status IS DISTINCT FROM 'in_progress' THEN RAISE EXCEPTION 'Service must be in progress before delivery'; END IF;
      IF v_escrow.id IS NULL OR v_escrow.status <> 'held' THEN RAISE EXCEPTION 'Service escrow is not held'; END IF;
      UPDATE public.service_booking_escrows
         SET delivered_at = now(), auto_release_at = now() + interval '72 hours'
       WHERE id = v_escrow.id AND status = 'held';
      v_target_status := 'delivered';

    WHEN 'confirm' THEN
      IF v_actor <> v_booking.client_id THEN RAISE EXCEPTION 'Only the customer can confirm delivery'; END IF;
      IF v_booking.status IS DISTINCT FROM 'delivered' THEN RAISE EXCEPTION 'The provider must mark the service delivered first'; END IF;
      IF v_escrow.id IS NULL OR v_escrow.status <> 'held' THEN RAISE EXCEPTION 'Service escrow is not available for release'; END IF;
      INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
      VALUES(v_booking.seller_id, v_escrow.amount_kobo, 'Service booking escrow release', v_booking.id);
      UPDATE public.service_booking_escrows
         SET status = 'released', resolved_at = now()
       WHERE id = v_escrow.id AND status = 'held';
      v_target_status := 'completed';

    WHEN 'cancel' THEN
      IF v_actor <> v_booking.client_id AND v_actor <> v_booking.seller_id THEN
        RAISE EXCEPTION 'Only booking participants can cancel';
      END IF;
      IF v_booking.status IS NULL OR v_booking.status NOT IN ('pending', 'quoted', 'confirmed') THEN
        RAISE EXCEPTION 'A service cannot be cancelled after work has started';
      END IF;
      IF v_escrow.id IS NOT NULL AND v_escrow.status = 'held' THEN
        INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
        VALUES(v_booking.client_id, v_escrow.amount_kobo, 'Service booking escrow refund', v_booking.id);
        UPDATE public.service_booking_escrows
           SET status = 'refunded', resolved_at = now()
         WHERE id = v_escrow.id AND status = 'held';
      ELSIF v_escrow.id IS NOT NULL AND v_escrow.status <> 'refunded' THEN
        RAISE EXCEPTION 'Service escrow is no longer eligible for cancellation';
      END IF;
      UPDATE public.service_booking_quotes
         SET status = 'cancelled', responded_at = now()
       WHERE booking_id = v_booking.id AND status = 'sent';
      v_target_status := 'cancelled';

    ELSE
      RAISE EXCEPTION 'Invalid booking action';
  END CASE;

  UPDATE public.gig_bookings SET status = v_target_status WHERE id = v_booking.id;
  RETURN jsonb_build_object(
    'success', true, 'booking_id', v_booking.id,
    'previous_status', v_booking.status, 'status', v_target_status
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.open_gig_booking_dispute(
  p_booking_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_booking public.gig_bookings%ROWTYPE;
  v_escrow public.service_booking_escrows%ROWTYPE;
  v_dispute public.service_booking_disputes%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 20 AND 5000 THEN
    RAISE EXCEPTION 'Describe the service issue in 20 to 5000 characters';
  END IF;
  SELECT * INTO v_booking FROM public.gig_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF v_actor <> v_booking.client_id THEN RAISE EXCEPTION 'Only the customer can dispute a service booking'; END IF;
  IF v_booking.status NOT IN ('in_progress','delivered') THEN
    RAISE EXCEPTION 'A dispute can only be opened while work is in progress or awaiting delivery confirmation';
  END IF;
  SELECT * INTO v_escrow FROM public.service_booking_escrows WHERE booking_id = v_booking.id FOR UPDATE;
  IF NOT FOUND OR v_escrow.status <> 'held' THEN RAISE EXCEPTION 'Service escrow is not available for dispute'; END IF;
  IF v_escrow.auto_release_at IS NOT NULL AND v_escrow.auto_release_at <= now() THEN
    RAISE EXCEPTION 'The service dispute window has closed';
  END IF;

  UPDATE public.service_booking_escrows SET status = 'disputed' WHERE id = v_escrow.id AND status = 'held';
  INSERT INTO public.service_booking_disputes(booking_id, escrow_id, opened_by, reason)
  VALUES(v_booking.id, v_escrow.id, v_actor, btrim(p_reason))
  RETURNING * INTO v_dispute;
  UPDATE public.gig_bookings SET status = 'disputed' WHERE id = v_booking.id;
  INSERT INTO public.notifications(user_id, type, title, body, data)
  VALUES(v_booking.seller_id, 'service_booking_disputed', 'Service booking disputed',
    'The customer raised an issue. Funds remain held pending platform review.',
    jsonb_build_object('booking_id', v_booking.id, 'dispute_id', v_dispute.id));

  RETURN jsonb_build_object('success', true, 'booking_id', v_booking.id, 'dispute_id', v_dispute.id, 'status', 'disputed');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.resolve_gig_booking_dispute(
  p_booking_id uuid,
  p_outcome text,
  p_resolution_note text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_booking public.gig_bookings%ROWTYPE;
  v_escrow public.service_booking_escrows%ROWTYPE;
  v_dispute public.service_booking_disputes%ROWTYPE;
  v_resolved_by uuid := auth.uid();
  v_target_status text;
  v_reason text;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'Only platform operations can resolve service disputes'; END IF;
  IF p_outcome NOT IN ('release_to_provider','refund_customer') THEN RAISE EXCEPTION 'Invalid service dispute outcome'; END IF;
  IF p_resolution_note IS NULL OR char_length(btrim(p_resolution_note)) NOT BETWEEN 10 AND 2000 THEN
    RAISE EXCEPTION 'A resolution note between 10 and 2000 characters is required';
  END IF;

  SELECT * INTO v_booking FROM public.gig_bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND OR v_booking.status <> 'disputed' THEN RAISE EXCEPTION 'Service booking is not disputed'; END IF;
  SELECT * INTO v_escrow FROM public.service_booking_escrows WHERE booking_id = v_booking.id FOR UPDATE;
  IF NOT FOUND OR v_escrow.status <> 'disputed' THEN RAISE EXCEPTION 'Service escrow is not disputed'; END IF;
  SELECT * INTO v_dispute FROM public.service_booking_disputes WHERE booking_id = v_booking.id FOR UPDATE;
  IF NOT FOUND OR v_dispute.status <> 'open' THEN RAISE EXCEPTION 'Open service dispute not found'; END IF;

  IF p_outcome = 'release_to_provider' THEN
    v_reason := 'Service booking dispute release';
    v_target_status := 'completed';
    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES(v_booking.seller_id, v_escrow.amount_kobo, v_reason, v_booking.id);
    UPDATE public.service_booking_escrows SET status = 'released', resolved_at = now() WHERE id = v_escrow.id;
  ELSE
    v_reason := 'Service booking dispute refund';
    v_target_status := 'cancelled';
    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES(v_booking.client_id, v_escrow.amount_kobo, v_reason, v_booking.id);
    UPDATE public.service_booking_escrows SET status = 'refunded', resolved_at = now() WHERE id = v_escrow.id;
  END IF;

  UPDATE public.service_booking_disputes
     SET status = 'resolved', resolution = p_outcome,
         resolution_note = btrim(p_resolution_note),
         resolved_by = v_resolved_by, resolved_at = now()
   WHERE id = v_dispute.id AND status = 'open';
  UPDATE public.gig_bookings SET status = v_target_status WHERE id = v_booking.id;
  INSERT INTO public.notifications(user_id, type, title, body, data)
  VALUES
    (v_booking.client_id, 'service_dispute_resolved', 'Service dispute resolved',
      CASE WHEN p_outcome = 'refund_customer' THEN 'The service escrow was refunded to your Campus Wallet.' ELSE 'The platform approved release of the service escrow to the provider.' END,
      jsonb_build_object('booking_id', v_booking.id, 'outcome', p_outcome)),
    (v_booking.seller_id, 'service_dispute_resolved', 'Service dispute resolved',
      CASE WHEN p_outcome = 'release_to_provider' THEN 'The platform approved release of the service escrow to your Campus Wallet.' ELSE 'The platform refunded the service escrow to the customer.' END,
      jsonb_build_object('booking_id', v_booking.id, 'outcome', p_outcome));

  RETURN jsonb_build_object('success', true, 'booking_id', v_booking.id, 'status', v_target_status, 'outcome', p_outcome);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.release_expired_service_booking_escrows()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_booking public.gig_bookings%ROWTYPE;
  v_escrow public.service_booking_escrows%ROWTYPE;
  v_count integer := 0;
BEGIN
  IF auth.role() IS NOT NULL AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Service booking settlement is service-only';
  END IF;

  FOR v_booking IN
    SELECT b.*
      FROM public.gig_bookings b
      JOIN public.service_booking_escrows e ON e.booking_id = b.id
     WHERE b.status = 'delivered'
       AND e.status = 'held'
       AND e.auto_release_at IS NOT NULL
       AND e.auto_release_at <= now()
       AND NOT EXISTS (
         SELECT 1 FROM public.service_booking_disputes d
         WHERE d.booking_id = b.id AND d.status = 'open'
       )
     ORDER BY e.auto_release_at, b.id
     FOR UPDATE OF b SKIP LOCKED
  LOOP
    SELECT * INTO v_escrow
      FROM public.service_booking_escrows
     WHERE booking_id = v_booking.id
     FOR UPDATE;
    IF NOT FOUND OR v_escrow.status <> 'held' OR v_escrow.auto_release_at > now() THEN
      CONTINUE;
    END IF;

    INSERT INTO public.plug_credit_ledger(user_id, amount, reason, reference_id)
    VALUES(v_booking.seller_id, v_escrow.amount_kobo, 'Service booking escrow auto-release', v_booking.id);
    UPDATE public.service_booking_escrows
       SET status = 'released', resolved_at = now()
     WHERE id = v_escrow.id AND status = 'held';
    UPDATE public.gig_bookings SET status = 'completed' WHERE id = v_booking.id AND status = 'delivered';
    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES
      (v_booking.client_id, 'service_escrow_auto_released', 'Service payment released',
        'The 72-hour delivery review window ended without a dispute. Funds were released to the provider.',
        jsonb_build_object('booking_id', v_booking.id, 'amount_kobo', v_escrow.amount_kobo)),
      (v_booking.seller_id, 'service_escrow_auto_released', 'Service payment released',
        'The 72-hour delivery review window ended. Your Campus Wallet has been credited.',
        jsonb_build_object('booking_id', v_booking.id, 'amount_kobo', v_escrow.amount_kobo));
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fund_gig_booking_escrow(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fund_gig_booking_escrow(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.transition_gig_booking(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_gig_booking(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.open_gig_booking_dispute(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.open_gig_booking_dispute(uuid, text) TO authenticated;
REVOKE ALL ON FUNCTION public.resolve_gig_booking_dispute(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_gig_booking_dispute(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.release_expired_service_booking_escrows() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expired_service_booking_escrows() TO service_role;

DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'service_booking_escrows'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.service_booking_escrows;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'service_booking_disputes'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.service_booking_disputes;
    END IF;
  END IF;
END;
$publication$;

COMMENT ON TABLE public.service_booking_escrows IS
  'Campus Wallet funds held against an accepted service quote until customer confirmation, dispute resolution or 72-hour delivery timeout.';
COMMENT ON FUNCTION public.release_expired_service_booking_escrows() IS
  'Service-role worker: releases held service escrow after the 72-hour delivery inspection window when no dispute is open.';

-- Schedule the 72-hour delivery-window settlement worker. The function itself
-- remains service-role-only over the API; pg_cron executes it as postgres.
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $cron$
DECLARE
  v_job_id bigint;
BEGIN
  SELECT jobid INTO v_job_id FROM cron.job WHERE jobname = 'service-booking-escrow-auto-release';
  IF v_job_id IS NOT NULL THEN PERFORM cron.unschedule(v_job_id); END IF;
  PERFORM cron.schedule(
    'service-booking-escrow-auto-release',
    '*/15 * * * *',
    'SELECT public.release_expired_service_booking_escrows();'
  );
END;
$cron$;
