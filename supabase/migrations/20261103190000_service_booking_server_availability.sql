-- Server-authoritative service booking availability and slot reservation.
-- No payment or escrow is performed by this lifecycle.
--
-- Locking the provider profile serializes requests across all of their services.
-- The partial unique index is the final protection against duplicate active slots.

CREATE UNIQUE INDEX IF NOT EXISTS gig_bookings_one_active_provider_slot_uidx
  ON public.gig_bookings (seller_id, slot_date, slot_time)
  WHERE status IN ('pending', 'quoted', 'confirmed', 'in_progress', 'delivered');

-- Booking creation must pass through the RPC so date, time, availability and
-- provider ownership are checked against the locked listing row.
DROP POLICY IF EXISTS "Clients create bookings" ON public.gig_bookings;
REVOKE INSERT ON public.gig_bookings FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_gig_booking_request(
  p_gig_id uuid,
  p_slot_date date,
  p_slot_time text,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_gig public.gigs%ROWTYPE;
  v_booking public.gig_bookings%ROWTYPE;
  v_requested_at timestamp without time zone;
  v_weekday text;
  v_constraint_name text;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  IF p_gig_id IS NULL OR p_slot_date IS NULL THEN
    RAISE EXCEPTION 'Choose a service, date and time';
  END IF;
  IF p_slot_time IS NULL OR p_slot_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN
    RAISE EXCEPTION 'Choose a valid booking time';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'Booking notes cannot exceed 2000 characters';
  END IF;

  -- The row lock serializes competing booking requests for this provider service.
  SELECT *
    INTO v_gig
    FROM public.gigs
   WHERE id = p_gig_id
   FOR UPDATE;
  IF NOT FOUND OR v_gig.active IS DISTINCT FROM true OR v_gig.is_available IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'This service is no longer available';
  END IF;
  IF v_gig.seller_id = v_actor THEN
    RAISE EXCEPTION 'You cannot book your own service';
  END IF;

  -- Serialize all service requests for one provider, including requests made
  -- against different gig listings owned by that provider.
  PERFORM 1 FROM public.profiles WHERE id = v_gig.seller_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Service provider profile not found'; END IF;

  v_requested_at := p_slot_date + p_slot_time::time;
  IF (v_requested_at AT TIME ZONE 'Africa/Lagos') <= now() THEN
    RAISE EXCEPTION 'Choose a future date and time';
  END IF;

  v_weekday := to_char(v_requested_at, 'FMDay');
  IF COALESCE(cardinality(v_gig.available_days), 0) > 0
     AND NOT (v_weekday = ANY(v_gig.available_days)) THEN
    RAISE EXCEPTION 'This provider is not available on %', v_weekday;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.gig_bookings b
     WHERE b.seller_id = v_gig.seller_id
       AND b.slot_date = p_slot_date
       AND b.slot_time = p_slot_time
       AND b.status IN ('pending', 'quoted', 'confirmed', 'in_progress', 'delivered')
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'code', 'slot_unavailable',
      'message', 'That service time has already been requested. Choose another time.'
    );
  END IF;

  INSERT INTO public.gig_bookings (
    gig_id, client_id, seller_id, slot_date, slot_time, notes, amount, status
  )
  VALUES (
    v_gig.id, v_actor, v_gig.seller_id, p_slot_date, p_slot_time,
    NULLIF(btrim(p_notes), ''), v_gig.starting_price, 'pending'
  )
  RETURNING * INTO v_booking;

  RETURN jsonb_build_object(
    'success', true,
    'booking_id', v_booking.id,
    'gig_id', v_booking.gig_id,
    'slot_date', v_booking.slot_date,
    'slot_time', v_booking.slot_time,
    'status', v_booking.status,
    'amount', v_booking.amount
  );
EXCEPTION
  WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;
    IF v_constraint_name = 'gig_bookings_one_active_provider_slot_uidx' THEN
      RETURN jsonb_build_object(
        'success', false,
        'code', 'slot_unavailable',
        'message', 'That service time has already been requested. Choose another time.'
      );
    END IF;
    RAISE;
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_gig_booking_request(uuid, date, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_gig_booking_request(uuid, date, text, text)
  TO authenticated;

COMMENT ON FUNCTION public.create_gig_booking_request(uuid, date, text, text) IS
  'Creates a service booking after server-side date, time, provider availability and active-slot validation. Does not collect or escrow payment.';
