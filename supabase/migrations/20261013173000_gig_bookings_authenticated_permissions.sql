-- Fix gig booking REST 42501 without bypassing row-level security.
-- Clients can create a booking for themselves and read bookings involving them.
GRANT SELECT, INSERT ON TABLE public.gig_bookings TO authenticated;

ALTER TABLE public.gig_bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Parties see own bookings" ON public.gig_bookings;
CREATE POLICY "Parties see own bookings"
  ON public.gig_bookings
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = client_id OR (SELECT auth.uid()) = seller_id);

DROP POLICY IF EXISTS "Clients create bookings" ON public.gig_bookings;
CREATE POLICY "Clients create bookings"
  ON public.gig_bookings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = client_id
    AND client_id <> seller_id
    AND EXISTS (
      SELECT 1
      FROM public.gigs AS g
      WHERE g.id = gig_bookings.gig_id
        AND g.seller_id = gig_bookings.seller_id
        AND g.active = true
    )
  );
