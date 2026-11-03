-- Campus Plug gear rentals: independent custody and wallet settlement lifecycle.
-- This intentionally does not reuse marketplace transactions: their release trigger
-- marks listings sold, which is correct for purchases and wrong for temporary rentals.

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS listing_mode text NOT NULL DEFAULT 'sale',
  ADD COLUMN IF NOT EXISTS rental_daily_rate_kobo bigint,
  ADD COLUMN IF NOT EXISTS rental_security_deposit_kobo bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rental_min_days smallint NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS rental_max_days smallint NOT NULL DEFAULT 30;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_listing_mode_check,
  ADD CONSTRAINT listings_listing_mode_check
    CHECK (listing_mode IN ('sale', 'both')),
  DROP CONSTRAINT IF EXISTS listings_rental_pricing_check,
  ADD CONSTRAINT listings_rental_pricing_check CHECK (
    (listing_mode = 'sale'
      AND rental_daily_rate_kobo IS NULL
      AND rental_security_deposit_kobo = 0)
    OR
    (listing_mode = 'both'
      AND rental_daily_rate_kobo > 0
      AND rental_security_deposit_kobo >= 0
      AND rental_min_days BETWEEN 1 AND 90
      AND rental_max_days BETWEEN rental_min_days AND 90)
  );

ALTER TABLE public.gear_rentals
  ADD COLUMN IF NOT EXISTS start_date date,
  ADD COLUMN IF NOT EXISTS end_date date,
  ADD COLUMN IF NOT EXISTS rental_fee_kobo bigint,
  ADD COLUMN IF NOT EXISTS security_deposit_kobo bigint,
  ADD COLUMN IF NOT EXISTS total_held_kobo bigint,
  ADD COLUMN IF NOT EXISTS rental_status text NOT NULL DEFAULT 'payment_pending',
  ADD COLUMN IF NOT EXISTS request_key uuid,
  ADD COLUMN IF NOT EXISTS pickup_code_hash text,
  ADD COLUMN IF NOT EXISTS pickup_code_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS pickup_code_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS return_code_hash text,
  ADD COLUMN IF NOT EXISTS return_code_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS return_code_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS picked_up_at timestamptz,
  ADD COLUMN IF NOT EXISTS returned_at timestamptz,
  ADD COLUMN IF NOT EXISTS custody_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disputed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dispute_reason text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid REFERENCES public.profiles(id),
  ADD COLUMN IF NOT EXISTS settlement_lender_share_bps integer,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.gear_rentals
  DROP CONSTRAINT IF EXISTS gear_rentals_status_check,
  ADD CONSTRAINT gear_rentals_status_check
    CHECK (rental_status IN ('payment_pending','funds_escrowed','active','return_pending','completed','cancelled','disputed','resolved')),
  DROP CONSTRAINT IF EXISTS gear_rentals_amounts_check,
  ADD CONSTRAINT gear_rentals_amounts_check CHECK (
    (rental_fee_kobo IS NULL OR rental_fee_kobo > 0)
    AND (security_deposit_kobo IS NULL OR security_deposit_kobo >= 0)
    AND (total_held_kobo IS NULL OR total_held_kobo > 0)
    AND (settlement_lender_share_bps IS NULL OR settlement_lender_share_bps BETWEEN 0 AND 10000)
  ),
  DROP CONSTRAINT IF EXISTS gear_rentals_period_amounts_check,
  ADD CONSTRAINT gear_rentals_period_amounts_check CHECK (
    (start_date IS NULL AND end_date IS NULL)
    OR
    (start_date IS NOT NULL AND end_date IS NOT NULL AND end_date >= start_date
      AND rental_fee_kobo > 0 AND security_deposit_kobo >= 0
      AND total_held_kobo = rental_fee_kobo + security_deposit_kobo)
  );

CREATE UNIQUE INDEX IF NOT EXISTS gear_rentals_borrower_request_key_uidx
  ON public.gear_rentals (borrower_id, request_key)
  WHERE request_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS gear_rentals_listing_dates_status_idx
  ON public.gear_rentals (listing_id, start_date, end_date, rental_status);

CREATE INDEX IF NOT EXISTS gear_rentals_participant_status_idx
  ON public.gear_rentals (borrower_id, rental_status, created_at DESC);

CREATE INDEX IF NOT EXISTS gear_rentals_lender_status_idx
  ON public.gear_rentals (lender_id, rental_status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.gear_rental_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rental_id uuid NOT NULL UNIQUE REFERENCES public.gear_rentals(id) ON DELETE RESTRICT,
  borrower_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  lender_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  rental_fee_kobo bigint NOT NULL CHECK (rental_fee_kobo > 0),
  security_deposit_kobo bigint NOT NULL CHECK (security_deposit_kobo >= 0),
  total_held_kobo bigint NOT NULL CHECK (total_held_kobo = rental_fee_kobo + security_deposit_kobo),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','settled','refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);

CREATE INDEX IF NOT EXISTS gear_rental_holds_borrower_status_idx
  ON public.gear_rental_holds (borrower_id, status);

CREATE INDEX IF NOT EXISTS gear_rental_holds_lender_status_idx
  ON public.gear_rental_holds (lender_id, status);

ALTER TABLE public.gear_rentals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gear_rental_holds ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.gear_rentals, public.gear_rental_holds TO authenticated;

DROP POLICY IF EXISTS "Rental borrowers and lenders can create rentals" ON public.gear_rentals;
DROP POLICY IF EXISTS "Rental participants can update gear rentals" ON public.gear_rentals;
DROP POLICY IF EXISTS "Rental participants can access gear rentals" ON public.gear_rentals;
DROP POLICY IF EXISTS gear_rentals_participant_select ON public.gear_rentals;
CREATE POLICY gear_rentals_participant_select
  ON public.gear_rentals FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = borrower_id OR (SELECT auth.uid()) = lender_id);

DROP POLICY IF EXISTS gear_rental_holds_participant_select ON public.gear_rental_holds;
CREATE POLICY gear_rental_holds_participant_select
  ON public.gear_rental_holds FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = borrower_id OR (SELECT auth.uid()) = lender_id);

REVOKE INSERT, UPDATE, DELETE ON public.gear_rentals, public.gear_rental_holds
  FROM PUBLIC, anon, authenticated;

-- Serialize rental reservations and sale checkouts on the listing row. A listing
-- with an active/future rental cannot be sold until the item has been returned.
CREATE OR REPLACE FUNCTION public.guard_listing_sale_during_rental()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_mode text;
BEGIN
  IF NEW.listing_id IS NULL THEN RETURN NEW; END IF;

  SELECT l.listing_mode
    INTO v_mode
    FROM public.listings l
   WHERE l.id = NEW.listing_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;

  IF EXISTS (
    SELECT 1
      FROM public.gear_rentals r
     WHERE r.listing_id = NEW.listing_id
       AND r.rental_status IN ('funds_escrowed','active','return_pending','disputed')
  ) THEN
    RAISE EXCEPTION 'This item has an active rental and cannot be purchased yet';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS guard_listing_sale_during_rental ON public.transactions;
CREATE TRIGGER guard_listing_sale_during_rental
  BEFORE INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_listing_sale_during_rental();

REVOKE ALL ON FUNCTION public.guard_listing_sale_during_rental() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_listing_active_rental_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.gear_rentals r
     WHERE r.listing_id = OLD.id
       AND r.rental_status IN ('funds_escrowed','active','return_pending','disputed')
  ) AND (
    (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IS DISTINCT FROM 'active')
    OR (NEW.listing_mode IS DISTINCT FROM OLD.listing_mode AND NEW.listing_mode IS DISTINCT FROM 'both')
  ) THEN
    RAISE EXCEPTION 'This listing cannot be removed from sale/rental availability while a rental is active';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS guard_listing_active_rental_mutation ON public.listings;
CREATE TRIGGER guard_listing_active_rental_mutation
  BEFORE UPDATE OF status, listing_mode ON public.listings
  FOR EACH ROW EXECUTE FUNCTION public.guard_listing_active_rental_mutation();

REVOKE ALL ON FUNCTION public.guard_listing_active_rental_mutation() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_gear_rental_request(
  p_listing_id uuid,
  p_start_date date,
  p_end_date date,
  p_request_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_borrower uuid := auth.uid();
  v_listing public.listings%ROWTYPE;
  v_existing public.gear_rentals%ROWTYPE;
  v_rental public.gear_rentals%ROWTYPE;
  v_days integer;
  v_fee bigint;
  v_deposit bigint;
  v_total bigint;
  v_balance bigint;
BEGIN
  IF v_borrower IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_listing_id IS NULL OR p_start_date IS NULL OR p_end_date IS NULL OR p_request_key IS NULL THEN
    RAISE EXCEPTION 'Listing, rental dates and request key are required';
  END IF;
  IF p_end_date < p_start_date THEN RAISE EXCEPTION 'Rental end date must be on or after its start date'; END IF;

  SELECT * INTO v_listing
    FROM public.listings
   WHERE id = p_listing_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Listing not found'; END IF;

  -- Retry recovery precedes listing availability checks so a committed request
  -- can still be recovered after the item has subsequently been sold or edited.
  SELECT * INTO v_existing
    FROM public.gear_rentals
   WHERE borrower_id = v_borrower AND request_key = p_request_key;

  IF FOUND THEN
    IF v_existing.listing_id <> p_listing_id
       OR v_existing.start_date <> p_start_date
       OR v_existing.end_date <> p_end_date THEN
      RAISE EXCEPTION 'Request key was already used for different rental details';
    END IF;
    RETURN jsonb_build_object(
      'success', true, 'idempotent', true, 'rental_id', v_existing.id,
      'rental_status', v_existing.rental_status, 'total_held_kobo', v_existing.total_held_kobo
    );
  END IF;

  IF v_listing.status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'This listing is no longer available';
  END IF;
  IF v_listing.listing_mode <> 'both' THEN
    RAISE EXCEPTION 'This listing is not available for rental';
  END IF;
  IF v_listing.seller_id = v_borrower THEN RAISE EXCEPTION 'You cannot rent your own item'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.transactions t
     WHERE t.listing_id = p_listing_id
       AND t.status IN ('pending','locked','meetup_initiated','release_requested','disputed')
  ) THEN
    RAISE EXCEPTION 'This item has an active purchase checkout and cannot be rented yet';
  END IF;

  IF p_start_date < (now() AT TIME ZONE 'Africa/Lagos')::date THEN
    RAISE EXCEPTION 'Choose today or a future rental start date';
  END IF;

  v_days := (p_end_date - p_start_date) + 1;
  IF v_days < v_listing.rental_min_days OR v_days > v_listing.rental_max_days THEN
    RAISE EXCEPTION 'Rental duration must be between % and % days',
      v_listing.rental_min_days, v_listing.rental_max_days;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.gear_rentals r
     WHERE r.listing_id = p_listing_id
       AND r.rental_status IN ('funds_escrowed','active','return_pending','disputed')
       AND daterange(r.start_date, r.end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) THEN
    RAISE EXCEPTION 'This item is already reserved for part of those dates';
  END IF;

  v_fee := v_listing.rental_daily_rate_kobo * v_days;
  v_deposit := v_listing.rental_security_deposit_kobo;
  v_total := v_fee + v_deposit;

  IF v_fee <= 0 OR v_total <= 0 OR v_total > 1000000 THEN
    RAISE EXCEPTION 'Campus Wallet rentals are limited to ₦10,000 total per reservation';
  END IF;

  PERFORM 1 FROM public.profiles WHERE id = v_borrower FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Borrower profile not found'; END IF;

  SELECT COALESCE(p.plug_credit_balance, 0)
    INTO v_balance
    FROM public.profiles p
   WHERE p.id = v_borrower;

  IF v_balance < v_total THEN RAISE EXCEPTION 'Insufficient Campus Wallet balance'; END IF;

  INSERT INTO public.gear_rentals (
    listing_id, borrower_id, lender_id, current_state, rental_status,
    start_date, end_date, rental_fee_kobo, security_deposit_kobo,
    total_held_kobo, request_key, logistics_meta
  )
  VALUES (
    p_listing_id, v_borrower, v_listing.seller_id, 'funds_escrowed', 'funds_escrowed',
    p_start_date, p_end_date, v_fee, v_deposit, v_total, p_request_key,
    jsonb_build_object('handoff_method','in_app_code','currency','NGN')
  )
  RETURNING * INTO v_rental;

  INSERT INTO public.gear_rental_holds (
    rental_id, borrower_id, lender_id, rental_fee_kobo, security_deposit_kobo, total_held_kobo
  )
  VALUES (v_rental.id, v_borrower, v_listing.seller_id, v_fee, v_deposit, v_total);

  INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
  VALUES (v_borrower, -v_total, 'Campus Plug gear rental escrow hold', v_rental.id);

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES (
    v_listing.seller_id, 'gear_rental_requested', 'New gear rental request',
    'A student reserved your item and the rental funds are held in Campus Wallet.',
    jsonb_build_object('rental_id', v_rental.id, 'listing_id', p_listing_id)
  );

  RETURN jsonb_build_object(
    'success', true, 'rental_id', v_rental.id, 'rental_status', v_rental.rental_status,
    'rental_days', v_days, 'rental_fee_kobo', v_fee,
    'security_deposit_kobo', v_deposit, 'total_held_kobo', v_total,
    'wallet_balance_after', v_balance - v_total
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.create_gear_rental_pickup_code(p_rental_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_rental public.gear_rentals%ROWTYPE;
  v_code text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_rental FROM public.gear_rentals WHERE id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_user <> v_rental.lender_id THEN RAISE EXCEPTION 'Only the lender can prepare item pickup'; END IF;
  IF v_rental.rental_status <> 'funds_escrowed' THEN RAISE EXCEPTION 'Rental is not ready for pickup'; END IF;
  IF (now() AT TIME ZONE 'Africa/Lagos')::date < v_rental.start_date
     OR (now() AT TIME ZONE 'Africa/Lagos')::date > v_rental.end_date THEN
    RAISE EXCEPTION 'Pickup codes are only available during the reserved rental dates';
  END IF;

  v_code := upper(encode(extensions.gen_random_bytes(4), 'hex'));
  UPDATE public.gear_rentals
     SET pickup_code_hash = encode(extensions.digest(v_code, 'sha256'), 'hex'),
         pickup_code_expires_at = now() + interval '15 minutes',
         pickup_code_attempts = 0,
         updated_at = now(),
         logistics_meta = COALESCE(logistics_meta, '{}'::jsonb) - 'pickup_code_hash'
   WHERE id = p_rental_id;

  RETURN jsonb_build_object('success', true, 'pickup_code', v_code, 'expires_at', now() + interval '15 minutes');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.confirm_gear_rental_pickup(p_rental_id uuid, p_pickup_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_rental public.gear_rentals%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_pickup_code IS NULL OR p_pickup_code !~ '^[A-F0-9]{8}$' THEN RAISE EXCEPTION 'Enter the 8-character pickup code'; END IF;

  SELECT * INTO v_rental FROM public.gear_rentals WHERE id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_user <> v_rental.borrower_id THEN RAISE EXCEPTION 'Only the borrower can confirm pickup'; END IF;
  IF v_rental.rental_status <> 'funds_escrowed' THEN RAISE EXCEPTION 'Rental is not awaiting pickup';
  END IF;
  IF (now() AT TIME ZONE 'Africa/Lagos')::date < v_rental.start_date THEN
    RAISE EXCEPTION 'Pickup is not available before the reserved start date';
  END IF;
  IF (now() AT TIME ZONE 'Africa/Lagos')::date > v_rental.end_date THEN
    RAISE EXCEPTION 'The reserved rental period has expired. Cancel or dispute this reservation.';
  END IF;
  IF v_rental.pickup_code_hash IS NULL OR v_rental.pickup_code_expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'code', 'pickup_code_expired', 'message', 'Pickup code is invalid or expired');
  END IF;
  IF v_rental.pickup_code_hash <> encode(extensions.digest(p_pickup_code, 'sha256'), 'hex') THEN
    UPDATE public.gear_rentals
       SET pickup_code_attempts = pickup_code_attempts + 1,
           pickup_code_hash = CASE WHEN pickup_code_attempts + 1 >= 5 THEN NULL ELSE pickup_code_hash END,
           pickup_code_expires_at = CASE WHEN pickup_code_attempts + 1 >= 5 THEN NULL ELSE pickup_code_expires_at END,
           updated_at = now()
     WHERE id = p_rental_id;
    RETURN jsonb_build_object('success', false, 'code', 'invalid_pickup_code', 'message', 'Pickup code is incorrect or locked after too many attempts');
  END IF;

  UPDATE public.gear_rentals
     SET rental_status = 'active', current_state = 'received_by_borrower',
         picked_up_at = now(), pickup_code_hash = NULL, pickup_code_expires_at = NULL, pickup_code_attempts = 0,
         updated_at = now()
   WHERE id = p_rental_id;

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES (
    v_rental.lender_id, 'gear_rental_picked_up', 'Item pickup confirmed',
    'The borrower confirmed receipt. The rental period is now active.',
    jsonb_build_object('rental_id', p_rental_id)
  );

  RETURN jsonb_build_object('success', true, 'rental_status', 'active', 'picked_up_at', now());
END;
$fn$;

CREATE OR REPLACE FUNCTION public.create_gear_rental_return_code(p_rental_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_rental public.gear_rentals%ROWTYPE;
  v_code text;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_rental FROM public.gear_rentals WHERE id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_user <> v_rental.borrower_id THEN RAISE EXCEPTION 'Only the borrower can prepare item return'; END IF;
  IF v_rental.rental_status NOT IN ('active','return_pending') THEN RAISE EXCEPTION 'Rental is not ready for return'; END IF;

  v_code := upper(encode(extensions.gen_random_bytes(4), 'hex'));
  UPDATE public.gear_rentals
     SET rental_status = 'return_pending', current_state = 'return_deposited',
         return_code_hash = encode(extensions.digest(v_code, 'sha256'), 'hex'),
         return_code_expires_at = now() + interval '15 minutes',
         return_code_attempts = 0,
         updated_at = now()
   WHERE id = p_rental_id;

  RETURN jsonb_build_object('success', true, 'return_code', v_code, 'expires_at', now() + interval '15 minutes');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.confirm_gear_rental_return(p_rental_id uuid, p_return_code text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_rental public.gear_rentals%ROWTYPE;
  v_hold public.gear_rental_holds%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_return_code IS NULL OR p_return_code !~ '^[A-F0-9]{8}$' THEN RAISE EXCEPTION 'Enter the 8-character return code'; END IF;

  SELECT * INTO v_rental FROM public.gear_rentals WHERE id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_user <> v_rental.lender_id THEN RAISE EXCEPTION 'Only the lender can confirm item return'; END IF;
  IF v_rental.rental_status <> 'return_pending' THEN RAISE EXCEPTION 'Rental is not awaiting return confirmation'; END IF;
  IF v_rental.return_code_hash IS NULL OR v_rental.return_code_expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'code', 'return_code_expired', 'message', 'Return code is invalid or expired');
  END IF;
  IF v_rental.return_code_hash <> encode(extensions.digest(p_return_code, 'sha256'), 'hex') THEN
    UPDATE public.gear_rentals
       SET return_code_attempts = return_code_attempts + 1,
           return_code_hash = CASE WHEN return_code_attempts + 1 >= 5 THEN NULL ELSE return_code_hash END,
           return_code_expires_at = CASE WHEN return_code_attempts + 1 >= 5 THEN NULL ELSE return_code_expires_at END,
           updated_at = now()
     WHERE id = p_rental_id;
    RETURN jsonb_build_object('success', false, 'code', 'invalid_return_code', 'message', 'Return code is incorrect or locked after too many attempts');
  END IF;

  SELECT * INTO v_hold FROM public.gear_rental_holds WHERE rental_id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_hold.status <> 'held' THEN RAISE EXCEPTION 'Rental wallet hold is not available'; END IF;

  -- Lock both wallets in a stable order to prevent opposite-direction rental
  -- settlements between the same two students from deadlocking.
  PERFORM 1 FROM public.profiles p
   WHERE p.id IN (v_hold.borrower_id, v_hold.lender_id)
   ORDER BY p.id
   FOR UPDATE;

  IF v_hold.rental_fee_kobo > 0 THEN
    INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
    VALUES (v_hold.lender_id, v_hold.rental_fee_kobo, 'Gear rental fee released after return', p_rental_id);
  END IF;
  IF v_hold.security_deposit_kobo > 0 THEN
    INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
    VALUES (v_hold.borrower_id, v_hold.security_deposit_kobo, 'Gear rental security deposit returned', p_rental_id);
  END IF;

  UPDATE public.gear_rental_holds SET status = 'settled', settled_at = now() WHERE id = v_hold.id;
  UPDATE public.gear_rentals
     SET rental_status = 'completed', current_state = 'returned_to_owner',
         returned_at = now(), return_code_hash = NULL, return_code_expires_at = NULL, return_code_attempts = 0,
         resolved_at = now(), updated_at = now()
   WHERE id = p_rental_id;

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES
    (v_hold.borrower_id, 'gear_rental_completed', 'Rental completed',
     'The item return was confirmed and your security deposit was returned.',
     jsonb_build_object('rental_id', p_rental_id)),
    (v_hold.lender_id, 'gear_rental_completed', 'Rental completed',
     'The item was returned and the rental fee was credited to your wallet.',
     jsonb_build_object('rental_id', p_rental_id));

  RETURN jsonb_build_object('success', true, 'rental_status', 'completed',
    'rental_fee_released_kobo', v_hold.rental_fee_kobo,
    'security_deposit_returned_kobo', v_hold.security_deposit_kobo);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cancel_gear_rental_request(p_rental_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_rental public.gear_rentals%ROWTYPE;
  v_hold public.gear_rental_holds%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_rental FROM public.gear_rentals WHERE id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_user NOT IN (v_rental.borrower_id, v_rental.lender_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF v_rental.rental_status <> 'funds_escrowed' THEN RAISE EXCEPTION 'A rental can only be cancelled before pickup'; END IF;

  SELECT * INTO v_hold FROM public.gear_rental_holds WHERE rental_id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_hold.status <> 'held' THEN RAISE EXCEPTION 'Rental wallet hold is not available'; END IF;

  INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
  VALUES (v_hold.borrower_id, v_hold.total_held_kobo, 'Gear rental cancellation refund', p_rental_id);

  UPDATE public.gear_rental_holds SET status = 'refunded', settled_at = now() WHERE id = v_hold.id;
  UPDATE public.gear_rentals
     SET rental_status = 'cancelled', current_state = 'funds_released_or_disputed',
         cancelled_at = now(), pickup_code_hash = NULL, pickup_code_expires_at = NULL, pickup_code_attempts = 0,
         updated_at = now()
   WHERE id = p_rental_id;

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES
    (v_hold.borrower_id, 'gear_rental_cancelled', 'Rental cancelled', 'Your rental hold was refunded to Campus Wallet.', jsonb_build_object('rental_id', p_rental_id)),
    (v_hold.lender_id, 'gear_rental_cancelled', 'Rental cancelled', 'The rental was cancelled before pickup.', jsonb_build_object('rental_id', p_rental_id));

  RETURN jsonb_build_object('success', true, 'rental_status', 'cancelled', 'refunded_kobo', v_hold.total_held_kobo);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.open_gear_rental_dispute(p_rental_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_user uuid := auth.uid();
  v_rental public.gear_rentals%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 20 AND 2000 THEN
    RAISE EXCEPTION 'Dispute reason must contain 20 to 2000 characters';
  END IF;

  SELECT * INTO v_rental FROM public.gear_rentals WHERE id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_user NOT IN (v_rental.borrower_id, v_rental.lender_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF v_rental.rental_status NOT IN ('funds_escrowed','active','return_pending') THEN
    RAISE EXCEPTION 'This rental can no longer be disputed';
  END IF;

  UPDATE public.gear_rentals
     SET rental_status = 'disputed', current_state = 'funds_released_or_disputed',
         disputed_at = now(), dispute_reason = trim(p_reason),
         pickup_code_hash = NULL, pickup_code_expires_at = NULL,
         return_code_hash = NULL, return_code_expires_at = NULL, return_code_attempts = 0,
         updated_at = now()
   WHERE id = p_rental_id;

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES
    (CASE WHEN v_user = v_rental.borrower_id THEN v_rental.lender_id ELSE v_rental.borrower_id END,
     'gear_rental_disputed', 'Gear rental dispute opened',
     'The rental funds remain held while Campus Plug reviews the dispute.',
     jsonb_build_object('rental_id', p_rental_id));

  RETURN jsonb_build_object('success', true, 'rental_status', 'disputed');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.resolve_gear_rental_dispute(
  p_rental_id uuid,
  p_lender_share_bps integer,
  p_admin_id uuid,
  p_custody_resolved boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_rental public.gear_rentals%ROWTYPE;
  v_hold public.gear_rental_holds%ROWTYPE;
  v_lender_amount bigint;
  v_borrower_amount bigint;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_lender_share_bps IS NULL OR p_lender_share_bps NOT BETWEEN 0 AND 10000 THEN RAISE EXCEPTION 'Invalid settlement split'; END IF;
  IF p_admin_id IS NULL THEN RAISE EXCEPTION 'Admin identity is required'; END IF;
  IF p_custody_resolved IS DISTINCT FROM true THEN RAISE EXCEPTION 'Confirm that the item is with the lender before settling this dispute'; END IF;

  SELECT * INTO v_rental FROM public.gear_rentals WHERE id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_rental.rental_status <> 'disputed' THEN RAISE EXCEPTION 'Rental dispute not found'; END IF;

  SELECT * INTO v_hold FROM public.gear_rental_holds WHERE rental_id = p_rental_id FOR UPDATE;
  IF NOT FOUND OR v_hold.status <> 'held' THEN RAISE EXCEPTION 'Rental wallet hold is not available'; END IF;

  PERFORM 1 FROM public.profiles p
   WHERE p.id IN (v_hold.borrower_id, v_hold.lender_id)
   ORDER BY p.id
   FOR UPDATE;

  v_lender_amount := (v_hold.total_held_kobo * p_lender_share_bps) / 10000;
  v_borrower_amount := v_hold.total_held_kobo - v_lender_amount;

  IF v_lender_amount > 0 THEN
    INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
    VALUES (v_hold.lender_id, v_lender_amount, 'Gear rental dispute settlement', p_rental_id);
  END IF;
  IF v_borrower_amount > 0 THEN
    INSERT INTO public.plug_credit_ledger (user_id, amount, reason, reference_id)
    VALUES (v_hold.borrower_id, v_borrower_amount, 'Gear rental dispute settlement refund', p_rental_id);
  END IF;

  UPDATE public.gear_rental_holds SET status = 'settled', settled_at = now() WHERE id = v_hold.id;
  UPDATE public.gear_rentals
     SET rental_status = 'resolved', current_state = 'funds_released_or_disputed',
         resolved_at = now(), resolved_by = p_admin_id, custody_resolved_at = now(),
         settlement_lender_share_bps = p_lender_share_bps, updated_at = now()
   WHERE id = p_rental_id;

  INSERT INTO public.notifications (user_id, type, title, body, data)
  VALUES
    (v_hold.borrower_id, 'gear_rental_dispute_resolved', 'Rental dispute resolved',
     'Campus Plug has settled the rental hold. Check your Campus Wallet.',
     jsonb_build_object('rental_id', p_rental_id)),
    (v_hold.lender_id, 'gear_rental_dispute_resolved', 'Rental dispute resolved',
     'Campus Plug has settled the rental hold. Check your Campus Wallet.',
     jsonb_build_object('rental_id', p_rental_id));

  RETURN jsonb_build_object('success', true, 'rental_status', 'resolved',
    'lender_credit_kobo', v_lender_amount, 'borrower_refund_kobo', v_borrower_amount);
END;
$fn$;

REVOKE ALL ON FUNCTION public.create_gear_rental_request(uuid,date,date,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_gear_rental_pickup_code(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_gear_rental_pickup(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.create_gear_rental_return_code(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.confirm_gear_rental_return(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_gear_rental_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.open_gear_rental_dispute(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.resolve_gear_rental_dispute(uuid,integer,uuid,boolean) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_gear_rental_request(uuid,date,date,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_gear_rental_pickup_code(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_gear_rental_pickup(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_gear_rental_return_code(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_gear_rental_return(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_gear_rental_request(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.open_gear_rental_dispute(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_gear_rental_dispute(uuid,integer,uuid,boolean) TO service_role;

COMMENT ON TABLE public.gear_rental_holds IS
  'Separate wallet escrow holds for rentals. Never linked to marketplace transactions because purchase settlement marks listings sold.';
COMMENT ON FUNCTION public.create_gear_rental_request(uuid,date,date,uuid) IS
  'Reserves an item date range and atomically debits Campus Wallet into a rental-specific hold. Maximum total hold is ₦10,000.';
COMMENT ON FUNCTION public.confirm_gear_rental_return(uuid,text) IS
  'Confirms lender receipt of returned gear, releases the rental fee and refunds the security deposit atomically.';
