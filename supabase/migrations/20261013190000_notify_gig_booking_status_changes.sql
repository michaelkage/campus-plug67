-- Notify the other participant when a booking is confirmed, completed, or cancelled.
CREATE OR REPLACE FUNCTION public.notify_gig_booking_status_changed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  recipient_id uuid;
  gig_title text;
  notification_type text;
  notification_title text;
  notification_body text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF (SELECT auth.uid()) = NEW.seller_id THEN
    recipient_id := NEW.client_id;
  ELSE
    recipient_id := NEW.seller_id;
  END IF;

  SELECT g.title INTO gig_title
  FROM public.gigs AS g
  WHERE g.id = NEW.gig_id;

  notification_type := CASE NEW.status
    WHEN 'confirmed' THEN 'booking_confirmed'
    WHEN 'completed' THEN 'booking_completed'
    WHEN 'cancelled' THEN 'booking_cancelled'
    ELSE 'booking_updated'
  END;
  notification_title := CASE NEW.status
    WHEN 'confirmed' THEN '✅ Booking Confirmed'
    WHEN 'completed' THEN '🎉 Service Completed'
    WHEN 'cancelled' THEN '❌ Booking Cancelled'
    ELSE 'Booking Updated'
  END;
  notification_body := COALESCE(gig_title, 'Your service booking') ||
    ' for ' || NEW.slot_date::text || ' at ' || NEW.slot_time ||
    ' is now ' || NEW.status || '.';

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES (
    recipient_id,
    notification_type,
    notification_title,
    notification_body,
    jsonb_build_object('gig_id', NEW.gig_id, 'booking_id', NEW.id, 'status', NEW.status)
  );

  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION public.notify_gig_booking_status_changed() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS notify_gig_booking_status_changed ON public.gig_bookings;
CREATE TRIGGER notify_gig_booking_status_changed
  AFTER UPDATE OF status ON public.gig_bookings
  FOR EACH ROW EXECUTE FUNCTION public.notify_gig_booking_status_changed();
