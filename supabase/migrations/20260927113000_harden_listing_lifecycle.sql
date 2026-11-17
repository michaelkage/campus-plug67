CREATE OR REPLACE FUNCTION public.guard_listing_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'sold' AND (
    NEW.status IS DISTINCT FROM OLD.status OR
    NEW.title IS DISTINCT FROM OLD.title OR
    NEW.description IS DISTINCT FROM OLD.description OR
    NEW.price IS DISTINCT FROM OLD.price OR
    NEW.images IS DISTINCT FROM OLD.images OR
    NEW.category IS DISTINCT FROM OLD.category OR
    NEW.hostel IS DISTINCT FROM OLD.hostel
  ) THEN
    RAISE EXCEPTION 'Sold listings cannot be edited or removed';
  END IF;

  IF NEW.status = 'deleted' AND EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.listing_id = OLD.id
      AND t.status IN ('pending','locked','meetup_initiated','release_requested','disputed')
  ) THEN
    RAISE EXCEPTION 'Listing has an active transaction and cannot be removed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_guard_lifecycle ON public.listings;
CREATE TRIGGER listings_guard_lifecycle
BEFORE UPDATE ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.guard_listing_lifecycle();

REVOKE ALL ON FUNCTION public.guard_listing_lifecycle() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_listing_lifecycle() TO authenticated,service_role;