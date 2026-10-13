-- Give buyers and providers a safe way to manage booking requests.
GRANT UPDATE ON TABLE public.gig_bookings TO authenticated;

DROP POLICY IF EXISTS "Parties update bookings" ON public.gig_bookings;
CREATE POLICY "Parties update bookings"
  ON public.gig_bookings
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = client_id OR (SELECT auth.uid()) = seller_id)
  WITH CHECK ((SELECT auth.uid()) = client_id OR (SELECT auth.uid()) = seller_id);

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

  IF (SELECT auth.uid()) = OLD.seller_id THEN
    IF NOT (
      (OLD.status = 'pending' AND NEW.status IN ('confirmed', 'cancelled'))
      OR (OLD.status = 'confirmed' AND NEW.status IN ('completed', 'cancelled'))
    ) THEN
      RAISE EXCEPTION 'Invalid provider booking status transition';
    END IF;
  ELSIF (SELECT auth.uid()) = OLD.client_id THEN
    IF NOT (OLD.status = 'pending' AND NEW.status = 'cancelled') THEN
      RAISE EXCEPTION 'Clients may only cancel pending bookings';
    END IF;
  ELSE
    RAISE EXCEPTION 'Only booking participants may update a booking';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS guard_gig_booking_update ON public.gig_bookings;
CREATE TRIGGER guard_gig_booking_update
  BEFORE UPDATE ON public.gig_bookings
  FOR EACH ROW EXECUTE FUNCTION public.guard_gig_booking_update();

REVOKE ALL ON FUNCTION public.guard_gig_booking_update() FROM PUBLIC, anon;
