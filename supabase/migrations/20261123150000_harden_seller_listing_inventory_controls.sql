-- Seller listing management: only sellers can archive/restore their own inventory.
-- Escrow and payment state transitions remain available to verified transaction
-- actors and trusted server-side transition functions.
CREATE OR REPLACE FUNCTION public.guard_listing_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_transaction boolean;
  v_valid_wallet_transition boolean;
BEGIN
  -- Provider webhooks/admin workers use the service role. Existing escrow RPCs
  -- explicitly set this transaction-local flag before changing listing state.
  IF auth.role() = 'service_role'
    OR current_setting('app.escrow_transition', true) = 'true' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required to update a listing';
  END IF;

  IF NEW.seller_id IS DISTINCT FROM OLD.seller_id
    OR NEW.university IS DISTINCT FROM OLD.university THEN
    RAISE EXCEPTION 'Listing ownership and campus cannot be changed';
  END IF;

  -- Seller self-service path: listing content can only be edited while the
  -- listing is active and has no in-flight purchase.
  IF auth.uid() = OLD.seller_id THEN
    IF OLD.status IN ('sold', 'reserved', 'pending') AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.price IS DISTINCT FROM OLD.price
      OR NEW.images IS DISTINCT FROM OLD.images
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.hostel IS DISTINCT FROM OLD.hostel
    ) THEN
      RAISE EXCEPTION 'Sold, reserved and pending listings are locked';
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
    ELSIF OLD.status = 'active' AND (
      NEW.title IS DISTINCT FROM OLD.title
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.price IS DISTINCT FROM OLD.price
      OR NEW.images IS DISTINCT FROM OLD.images
      OR NEW.category IS DISTINCT FROM OLD.category
      OR NEW.hostel IS DISTINCT FROM OLD.hostel
    ) THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.transactions t
        WHERE t.listing_id = OLD.id
          AND t.status IN ('pending','locked','meetup_initiated','release_requested','disputed')
      ) INTO v_active_transaction;
      IF v_active_transaction THEN
        RAISE EXCEPTION 'Listing has an active transaction and cannot be edited';
      END IF;
    END IF;

    RETURN NEW;
  END IF;

  -- A buyer may only cause the wallet escrow RPC's proven reservation,
  -- release or refund transitions. They cannot edit seller listing content.
  IF NEW.title IS DISTINCT FROM OLD.title
    OR NEW.description IS DISTINCT FROM OLD.description
    OR NEW.price IS DISTINCT FROM OLD.price
    OR NEW.images IS DISTINCT FROM OLD.images
    OR NEW.category IS DISTINCT FROM OLD.category
    OR NEW.hostel IS DISTINCT FROM OLD.hostel THEN
    RAISE EXCEPTION 'Only the listing owner may edit listing content';
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.transactions t
    WHERE t.listing_id = OLD.id
      AND t.buyer_id = auth.uid()
      AND t.seller_id = OLD.seller_id
      AND t.payment_method = 'campus_wallet'
      AND (
        (OLD.status = 'active' AND NEW.status = 'reserved'
          AND t.status = 'locked'
          AND EXISTS (
            SELECT 1 FROM public.wallet_escrow_holds h
            WHERE h.transaction_id = t.id AND h.status = 'held'
          ))
        OR
        (OLD.status = 'reserved' AND NEW.status = 'sold'
          AND t.status = 'released'
          AND EXISTS (
            SELECT 1 FROM public.wallet_escrow_holds h
            WHERE h.transaction_id = t.id AND h.status = 'released'
          ))
        OR
        (OLD.status = 'sold' AND NEW.status = 'active'
          AND t.status = 'cancelled'
          AND EXISTS (
            SELECT 1 FROM public.wallet_escrow_holds h
            WHERE h.transaction_id = t.id AND h.status = 'refunded'
          ))
      )
  ) INTO v_valid_wallet_transition;

  IF NOT v_valid_wallet_transition THEN
    RAISE EXCEPTION 'Listing status transition is not authorized by a valid transaction';
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
