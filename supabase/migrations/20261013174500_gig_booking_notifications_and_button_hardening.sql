-- Keep notification rows private and deliver booking alerts transactionally.
-- The booking insert trigger handles notifications for both gig-booking UIs.
REVOKE ALL ON TABLE public.notifications FROM anon;
REVOKE INSERT, DELETE ON TABLE public.notifications FROM authenticated;
GRANT SELECT, UPDATE ON TABLE public.notifications TO authenticated;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow users to see their own notifications" ON public.notifications;
DROP POLICY IF EXISTS "Users see own notifications" ON public.notifications;
CREATE POLICY "Users see own notifications"
  ON public.notifications FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

DROP POLICY IF EXISTS "Users update own notifications" ON public.notifications;
CREATE POLICY "Users update own notifications"
  ON public.notifications FOR UPDATE TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION public.notify_gig_booking_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  gig_title text;
  client_name text;
BEGIN
  SELECT g.title INTO gig_title
  FROM public.gigs AS g
  WHERE g.id = NEW.gig_id AND g.seller_id = NEW.seller_id;

  SELECT p.full_name INTO client_name
  FROM public.profiles AS p
  WHERE p.id = NEW.client_id;

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES (
    NEW.seller_id,
    'new_booking',
    '📅 New Booking Request!',
    COALESCE(client_name, 'A student') || ' wants to book "' ||
      COALESCE(gig_title, 'your service') || '" on ' ||
      NEW.slot_date::text || ' at ' || NEW.slot_time,
    jsonb_build_object(
      'gig_id', NEW.gig_id,
      'booking_id', NEW.id,
      'client_id', NEW.client_id,
      'slot_date', NEW.slot_date,
      'slot_time', NEW.slot_time
    )
  );
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.notify_gig_booking_created() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS notify_gig_booking_created ON public.gig_bookings;
CREATE TRIGGER notify_gig_booking_created
  AFTER INSERT ON public.gig_bookings
  FOR EACH ROW EXECUTE FUNCTION public.notify_gig_booking_created();
