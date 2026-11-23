-- Seller listing management: inventory status is server-owned for commerce states.
-- Sellers may archive active listings and restore archived listings only when no
-- transaction is in progress. They cannot mark listings reserved or sold.
CREATE OR REPLACE FUNCTION public.guard_listing_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_transaction boolean;
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL OR auth.uid() <> OLD.seller_id THEN
    RAISE EXCEPTION 'Only the listing owner may manage this listing';
  END IF;

  IF OLD.status = 'sold' THEN
    IF NEW.status IS DISTINCT FROM OLD.status
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.price IS DISTINCT FROM OLD.price
      OR NEW.images IS DISTINCT FROM OLD.images
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.hostel IS DISTINCT FROM OLD.hostel THEN
      RAISE EXCEPTION 'Sold listings cannot be edited or removed';
    END IF;
  END IF;

  IF OLD.status = 'reserved' AND (
    NEW.status IS DISTINCT FROM OLD.status
    OR NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.price IS DISTINCT FROM OLD.price
    OR NEW.images IS DISTINCT FROM OLD.images
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.hostel IS DISTINCT FROM OLD.hostel
  ) THEN
    RAISE EXCEPTION 'Reserved listings are locked while escrow is in progress';
  END IF;

  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id
    OR NEW.university IS DISTINCT FROM OLD.university THEN
    RAISE EXCEPTION 'Listing ownership and campus cannot be changed';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
      (OLD.status = 'active' AND NEW.status = 'deleted')
      OR (OLD.status IN ('deleted','removed') AND NEW.status = 'active')
    ) THEN
      RAISE EXCEPTION 'Listing status is managed by the transaction system';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.listing_id = OLD.id
        AND t.status IN ('pending','locked','meetup_initiated','release_requested','disputed')
    ) INTO v_active_transaction;

    IF v_active_transaction THEN
      RAISE EXCEPTION 'Listing has an active transaction and cannot be archived or restored';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS listings_guard_lifecycle ON public.listings;
CREATE TRIGGER listings_guard_lifecycle
BEFORE UPDATE ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.guard_listing_lifecycle();

REVOKE ALL ON FUNCTION public.guard_listing_lifecycle() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_listing_lifecycle() TO authenticated, service_role;
