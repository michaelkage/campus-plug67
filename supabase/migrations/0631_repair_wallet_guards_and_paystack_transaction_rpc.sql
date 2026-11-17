-- Repair wallet balance-trigger authorization and route Paystack transaction creation
-- through a validated server-side RPC. Applied to the connected Supabase project.

CREATE OR REPLACE FUNCTION public.guard_profile_sensitive_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF auth.role() = 'service_role' THEN RETURN NEW; END IF;

  IF COALESCE(current_setting('app.financial_write', true), '0') = '1'
     AND NEW.email IS NOT DISTINCT FROM OLD.email
     AND NEW.plug_score IS NOT DISTINCT FROM OLD.plug_score
     AND NEW.total_sales IS NOT DISTINCT FROM OLD.total_sales
     AND NEW.total_earnings IS NOT DISTINCT FROM OLD.total_earnings
     AND NEW.badges IS NOT DISTINCT FROM OLD.badges
     AND NEW.is_verified IS NOT DISTINCT FROM OLD.is_verified
     AND NEW.is_suspended IS NOT DISTINCT FROM OLD.is_suspended
     AND NEW.referral_code IS NOT DISTINCT FROM OLD.referral_code
     AND NEW.streak_days IS NOT DISTINCT FROM OLD.streak_days
     AND NEW.juror_streak IS NOT DISTINCT FROM OLD.juror_streak
     AND NEW.free_listing_tokens IS NOT DISTINCT FROM OLD.free_listing_tokens
  THEN RETURN NEW; END IF;

  IF auth.uid() IS NULL OR auth.uid() <> OLD.id OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Profile mutation is not authorized';
  END IF;
  IF NEW.email IS DISTINCT FROM OLD.email
     OR NEW.plug_score IS DISTINCT FROM OLD.plug_score
     OR NEW.total_sales IS DISTINCT FROM OLD.total_sales
     OR NEW.total_earnings IS DISTINCT FROM OLD.total_earnings
     OR NEW.badges IS DISTINCT FROM OLD.badges
     OR NEW.is_verified IS DISTINCT FROM OLD.is_verified
     OR NEW.is_suspended IS DISTINCT FROM OLD.is_suspended
     OR NEW.balance IS DISTINCT FROM OLD.balance
     OR NEW.plug_credit_balance IS DISTINCT FROM OLD.plug_credit_balance
     OR NEW.referral_code IS DISTINCT FROM OLD.referral_code
     OR NEW.streak_days IS DISTINCT FROM OLD.streak_days
     OR NEW.juror_streak IS DISTINCT FROM OLD.juror_streak
     OR NEW.free_listing_tokens IS DISTINCT FROM OLD.free_listing_tokens
  THEN RAISE EXCEPTION 'Protected profile fields are server-managed'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.process_atomic_balance_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_bal bigint; new_bal bigint; previous_financial_write text;
BEGIN
  SELECT COALESCE(plug_credit_balance,0) INTO current_bal
  FROM public.profiles WHERE id=NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet owner does not exist'; END IF;
  new_bal := current_bal + NEW.amount;
  IF new_bal < 0 THEN RAISE EXCEPTION 'Insufficient PlugCredit balance'; END IF;

  previous_financial_write := current_setting('app.financial_write', true);
  PERFORM set_config('app.financial_write', '1', true);
  BEGIN
    UPDATE public.profiles SET plug_credit_balance=new_bal,balance=new_bal WHERE id=NEW.user_id;
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.financial_write', COALESCE(previous_financial_write, '0'), true);
    RAISE;
  END;
  PERFORM set_config('app.financial_write', COALESCE(previous_financial_write, '0'), true);
  NEW.balance_after := new_bal;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.create_pending_paystack_transaction(p_listing_id uuid, p_paystack_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_buyer uuid := auth.uid(); v_listing public.listings%ROWTYPE; v_tx public.transactions%ROWTYPE;
BEGIN
  IF v_buyer IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_paystack_ref IS NULL OR length(p_paystack_ref) NOT BETWEEN 8 AND 100
     OR p_paystack_ref !~ '^CP-[A-Za-z0-9-]+$' THEN RAISE EXCEPTION 'Invalid payment reference'; END IF;

  SELECT * INTO v_listing FROM public.listings
  WHERE id=p_listing_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing is not available'; END IF;
  IF v_listing.seller_id=v_buyer THEN RAISE EXCEPTION 'You cannot buy your own listing'; END IF;
  IF v_listing.price IS NULL OR v_listing.price <= 0 THEN RAISE EXCEPTION 'Invalid listing amount'; END IF;
  IF EXISTS (SELECT 1 FROM public.transactions WHERE paystack_ref=p_paystack_ref) THEN
    RAISE EXCEPTION 'Payment reference already exists';
  END IF;

  INSERT INTO public.transactions(listing_id,buyer_id,seller_id,amount,status,paystack_ref)
  VALUES(v_listing.id,v_buyer,v_listing.seller_id,v_listing.price,'pending',p_paystack_ref)
  RETURNING * INTO v_tx;
  RETURN jsonb_build_object('id',v_tx.id,'listing_id',v_tx.listing_id,'buyer_id',v_tx.buyer_id,
    'seller_id',v_tx.seller_id,'amount',v_tx.amount,'status',v_tx.status,'paystack_ref',v_tx.paystack_ref);
END; $$;

REVOKE ALL ON FUNCTION public.create_pending_paystack_transaction(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pending_paystack_transaction(uuid,text) TO authenticated;
COMMENT ON FUNCTION public.create_pending_paystack_transaction(uuid,text)
IS 'Creates a pending Paystack escrow transaction using server-validated listing price and authenticated buyer identity.';
