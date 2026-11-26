-- Preserve listing lifecycle protections while allowing only the internal
-- nested trust-scanner trigger to update derived trust metadata.

-- A transaction-scoped, unguessable capability lets only the trusted scanner
-- bypass the listing trust-field guard. A caller-set GUC alone is insufficient.
CREATE SCHEMA IF NOT EXISTS app_private AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA app_private FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS app_private.listing_trust_scan_capabilities (
  token uuid PRIMARY KEY,
  transaction_id bigint NOT NULL,
  backend_pid integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app_private.listing_trust_scan_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.listing_trust_scan_capabilities FROM PUBLIC, anon, authenticated, service_role;

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

  -- Only a random capability row created by scan_listing_trust in this
  -- transaction/backend can authorize the internal trust-field update.
  IF EXISTS (
    SELECT 1
      FROM app_private.listing_trust_scan_capabilities c
     WHERE c.token::text = current_setting('app.listing_trust_scan_write', true)
       AND c.transaction_id = txid_current()
       AND c.backend_pid = pg_backend_pid()
  ) THEN
    RETURN NEW;
  END IF;

  IF (
       NEW.plugpay_protected IS DISTINCT FROM OLD.plugpay_protected
       OR NEW.visibility_score IS DISTINCT FROM OLD.visibility_score
       OR NEW.trust_score IS DISTINCT FROM OLD.trust_score
     ) THEN
    RAISE EXCEPTION 'Listing trust metadata is system-managed';
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
        (OLD.status = 'reserved' AND NEW.status = 'active'
          AND t.status = 'cancelled'
          AND EXISTS (
            SELECT 1 FROM public.wallet_escrow_holds h
            WHERE h.transaction_id = t.id AND h.status = 'refunded'
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



create or replace function public.scan_listing_trust(p_listing_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, public, app_private as $
declare
  desc_text     text;
  has_contact   boolean;
  new_score     integer;
  previous_scan_flag text;
  v_scan_capability uuid := gen_random_uuid();
begin
  previous_scan_flag := current_setting('app.listing_trust_scan_write', true);
  INSERT INTO app_private.listing_trust_scan_capabilities(token, transaction_id, backend_pid)
  VALUES (v_scan_capability, txid_current(), pg_backend_pid());
  PERFORM set_config('app.listing_trust_scan_write', v_scan_capability::text, true);

  select description into desc_text
  from public.listings where id = p_listing_id;

  -- Detect contact info patterns in description
  has_contact := desc_text ~* '(0[789][01]\d{8}|\+?234[789][01]\d{8}|whatsapp|wa\.me|@\w+|instagram|telegram|opay|palmpay|kuda)';

  if has_contact then
    update public.listings set
      plugpay_protected = false,
      visibility_score  = greatest(visibility_score - 30, 20),
      trust_score       = greatest(trust_score - 40, 10)
    where id = p_listing_id;
  else
    update public.listings set
      plugpay_protected = true,
      visibility_score  = least(visibility_score + 5, 100),
      trust_score       = least(trust_score + 5, 100)
    where id = p_listing_id;
  end if;

  DELETE FROM app_private.listing_trust_scan_capabilities
   WHERE token = v_scan_capability
     AND transaction_id = txid_current()
     AND backend_pid = pg_backend_pid();
  PERFORM set_config('app.listing_trust_scan_write', COALESCE(previous_scan_flag, ''), true);
end;
$$;

REVOKE ALL ON FUNCTION public.scan_listing_trust(uuid) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.scan_listing_trust(uuid) IS
  'Recomputes listing trust metadata only through the internal listing-change trigger.';
