-- Server-authoritative service booking quotes and delivery lifecycle.
-- This phase intentionally does not move money. Payment/escrow is a separate,
-- follow-up migration so no booking can imply funds are protected before that exists.

-- Extend the existing booking status constraint for the quote/delivery state machine.
ALTER TABLE public.gig_bookings
  DROP CONSTRAINT IF EXISTS gig_bookings_status_check;
ALTER TABLE public.gig_bookings
  ADD CONSTRAINT gig_bookings_status_check
  CHECK (status = ANY (ARRAY[
    'pending'::text, 'quoted'::text, 'confirmed'::text,
    'in_progress'::text, 'delivered'::text, 'completed'::text,
    'cancelled'::text
  ]));

CREATE TABLE IF NOT EXISTS public.service_booking_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL REFERENCES public.gig_bookings(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  scope text NOT NULL CHECK (char_length(btrim(scope)) BETWEEN 20 AND 5000),
  status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'accepted', 'declined', 'expired', 'cancelled')),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  responded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_booking_quotes_parties_distinct CHECK (client_id <> seller_id)
);

CREATE INDEX IF NOT EXISTS service_booking_quotes_booking_created_idx
  ON public.service_booking_quotes(booking_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS service_booking_quotes_one_open_per_booking_uidx
  ON public.service_booking_quotes(booking_id)
  WHERE status = 'sent';
CREATE UNIQUE INDEX IF NOT EXISTS service_booking_quotes_one_accepted_per_booking_uidx
  ON public.service_booking_quotes(booking_id)
  WHERE status = 'accepted';

ALTER TABLE public.service_booking_quotes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Booking parties read service quotes" ON public.service_booking_quotes;
CREATE POLICY "Booking parties read service quotes"
  ON public.service_booking_quotes
  FOR SELECT TO authenticated
  USING (
    (SELECT auth.uid()) = client_id
    OR (SELECT auth.uid()) = seller_id
  );

REVOKE ALL ON public.service_booking_quotes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.service_booking_quotes TO authenticated;
GRANT ALL ON public.service_booking_quotes TO service_role;

-- All booking transitions now pass through narrow RPCs. The legacy direct
-- UPDATE path is removed so participants cannot skip quote acceptance/delivery.
REVOKE UPDATE ON public.gig_bookings FROM authenticated;

CREATE OR REPLACE FUNCTION public.guard_gig_booking_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.gig_id IS DISTINCT FROM OLD.gig_id
    OR NEW.client_id IS DISTINCT FROM OLD.client_id
    OR NEW.seller_id IS DISTINCT FROM OLD.seller_id
    OR NEW.slot_date IS DISTINCT FROM OLD.slot_date
    OR NEW.slot_time IS DISTINCT FROM OLD.slot_time
    OR NEW.notes IS DISTINCT FROM OLD.notes
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Booking details cannot be changed after submission';
  END IF;

  -- The only status writer is a SECURITY DEFINER RPC owned by postgres.
  IF current_user = 'postgres' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Booking status changes must use the service booking actions';
END;
$fn$;

CREATE OR REPLACE FUNCTION public.send_gig_booking_quote(
  p_booking_id uuid,
  p_amount_kobo bigint,
  p_scope text,
  p_expires_at timestamptz DEFAULT now() + interval '24 hours'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_booking public.gig_bookings%ROWTYPE;
  v_quote public.service_booking_quotes%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_amount_kobo IS NULL OR p_amount_kobo < 100 THEN
    RAISE EXCEPTION 'Quote must be at least ₦1';
  END IF;
  IF p_amount_kobo > 100000000 THEN
    RAISE EXCEPTION 'Quote exceeds the service price limit';
  END IF;
  IF p_scope IS NULL OR char_length(btrim(p_scope)) NOT BETWEEN 20 AND 5000 THEN
    RAISE EXCEPTION 'Describe the service scope in 20 to 5000 characters';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= now()
     OR p_expires_at > now() + interval '7 days' THEN
    RAISE EXCEPTION 'Quote expiry must be within the next 7 days';
  END IF;

  SELECT * INTO v_booking
  FROM public.gig_bookings
  WHERE id = p_booking_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF v_actor <> v_booking.seller_id THEN RAISE EXCEPTION 'Only the provider can send a quote'; END IF;
  IF v_booking.status NOT IN ('pending', 'confirmed', 'quoted') THEN
    RAISE EXCEPTION 'Booking is not eligible for a quote';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.service_booking_quotes
    WHERE booking_id = v_booking.id AND status = 'accepted'
  ) THEN
    RAISE EXCEPTION 'An accepted quote already exists for this booking';
  END IF;

  UPDATE public.service_booking_quotes
     SET status = 'expired', responded_at = now()
   WHERE booking_id = v_booking.id AND status = 'sent';

  INSERT INTO public.service_booking_quotes(
    booking_id, client_id, seller_id, amount_kobo, scope, expires_at
  )
  VALUES (
    v_booking.id, v_booking.client_id, v_booking.seller_id,
    p_amount_kobo, btrim(p_scope), p_expires_at
  )
  RETURNING * INTO v_quote;

  UPDATE public.gig_bookings
     SET status = 'quoted'
   WHERE id = v_booking.id;

  RETURN jsonb_build_object(
    'success', true,
    'quote_id', v_quote.id,
    'booking_id', v_booking.id,
    'amount_kobo', v_quote.amount_kobo,
    'expires_at', v_quote.expires_at,
    'status', v_quote.status
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.respond_gig_booking_quote(
  p_quote_id uuid,
  p_accept boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_quote public.service_booking_quotes%ROWTYPE;
  v_booking public.gig_bookings%ROWTYPE;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_quote
  FROM public.service_booking_quotes
  WHERE id = p_quote_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found'; END IF;
  IF v_actor <> v_quote.client_id THEN RAISE EXCEPTION 'Only the customer can respond to this quote'; END IF;
  IF v_quote.status <> 'sent' THEN RAISE EXCEPTION 'Quote is no longer awaiting a response'; END IF;

  SELECT * INTO v_booking
  FROM public.gig_bookings
  WHERE id = v_quote.booking_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;
  IF v_booking.status <> 'quoted' THEN RAISE EXCEPTION 'Booking is not awaiting quote acceptance'; END IF;

  IF v_quote.expires_at <= now() THEN
    UPDATE public.service_booking_quotes SET status = 'expired', responded_at = now() WHERE id = v_quote.id;
    UPDATE public.gig_bookings SET status = 'pending' WHERE id = v_booking.id;
    RETURN jsonb_build_object('success', false, 'code', 'quote_expired');
  END IF;

  IF p_accept THEN
    UPDATE public.service_booking_quotes
       SET status = 'accepted', accepted_at = now(), responded_at = now()
     WHERE id = v_quote.id;
    UPDATE public.gig_bookings SET status = 'confirmed', amount = v_quote.amount_kobo WHERE id = v_booking.id;
  ELSE
    UPDATE public.service_booking_quotes
       SET status = 'declined', responded_at = now()
     WHERE id = v_quote.id;
    UPDATE public.gig_bookings SET status = 'pending' WHERE id = v_booking.id;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'accepted', p_accept,
    'booking_id', v_booking.id,
    'quote_id', v_quote.id
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
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_booking public.gig_bookings%ROWTYPE;
  v_target_status text;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_booking
  FROM public.gig_bookings
  WHERE id = p_booking_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Booking not found'; END IF;

  CASE p_action
    WHEN 'start' THEN
      IF v_actor <> v_booking.seller_id THEN RAISE EXCEPTION 'Only the provider can start the service'; END IF;
      IF v_booking.status <> 'confirmed' THEN RAISE EXCEPTION 'Accept the final quote before starting work'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.service_booking_quotes
        WHERE booking_id = v_booking.id AND status = 'accepted'
      ) THEN RAISE EXCEPTION 'An accepted final quote is required'; END IF;
      v_target_status := 'in_progress';
    WHEN 'deliver' THEN
      IF v_actor <> v_booking.seller_id THEN RAISE EXCEPTION 'Only the provider can mark the service delivered'; END IF;
      IF v_booking.status <> 'in_progress' THEN RAISE EXCEPTION 'Service must be in progress before delivery'; END IF;
      v_target_status := 'delivered';
    WHEN 'confirm' THEN
      IF v_actor <> v_booking.client_id THEN RAISE EXCEPTION 'Only the customer can confirm delivery'; END IF;
      IF v_booking.status <> 'delivered' THEN RAISE EXCEPTION 'The provider must mark the service delivered first'; END IF;
      v_target_status := 'completed';
    WHEN 'cancel' THEN
      IF v_actor <> v_booking.client_id AND v_actor <> v_booking.seller_id THEN
        RAISE EXCEPTION 'Only booking participants can cancel';
      END IF;
      IF v_booking.status NOT IN ('pending', 'quoted', 'confirmed') THEN
        RAISE EXCEPTION 'A service cannot be cancelled after work has started';
      END IF;
      UPDATE public.service_booking_quotes
         SET status = 'cancelled', responded_at = now()
       WHERE booking_id = v_booking.id AND status = 'sent';
      v_target_status := 'cancelled';
    ELSE
      RAISE EXCEPTION 'Invalid booking action';
  END CASE;

  UPDATE public.gig_bookings
     SET status = v_target_status
   WHERE id = v_booking.id;

  RETURN jsonb_build_object(
    'success', true,
    'booking_id', v_booking.id,
    'previous_status', v_booking.status,
    'status', v_target_status
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.send_gig_booking_quote(uuid, bigint, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_gig_booking_quote(uuid, bigint, text, timestamptz)
  TO authenticated;

REVOKE ALL ON FUNCTION public.respond_gig_booking_quote(uuid, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.respond_gig_booking_quote(uuid, boolean)
  TO authenticated;

REVOKE ALL ON FUNCTION public.transition_gig_booking(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transition_gig_booking(uuid, text)
  TO authenticated;

COMMENT ON TABLE public.service_booking_quotes IS
  'Provider-issued final service scope and price. Quote acceptance does not collect or escrow payment.';
