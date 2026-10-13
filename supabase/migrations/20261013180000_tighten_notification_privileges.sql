-- Remove legacy table-level privileges not required by the client.
-- Booking alerts are inserted by the database trigger, not by browser clients.
REVOKE ALL ON TABLE public.notifications FROM anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.notifications TO authenticated;
