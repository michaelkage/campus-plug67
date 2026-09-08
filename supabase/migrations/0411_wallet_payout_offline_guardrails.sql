-- Migration 041: Campus Wallet, payout-pending state, and search guardrails
-- Uses the existing immutable plug_credit_ledger as the stored-value ledger.
-- Micro-escrow is limited to low-value campus purchases/rentals (<= ₦10,000).

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS payout_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (payout_status IN ('not_applicable','approved_for_settlement','processing','paid','failed')),
  ADD COLUMN IF NOT EXISTS payout_reference text,
  ADD COLUMN IF NOT EXISTS payout_failure_reason text,
  ADD COLUMN IF NOT EXISTS payout_approved_at timestamptz;

CREATE INDEX IF NOT EXISTS transactions_payout_status_idx
  ON public.transactions(payout_status, updated_at)
  WHERE payout_status IN ('approved_for_settlement','processing','failed');

CREATE TABLE IF NOT EXISTS public.wallet_funding_intents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','credited','rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  credited_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.wallet_escrow_holds (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  transaction_id uuid NOT NULL UNIQUE REFERENCES public.transactions(id) ON DELETE CASCADE,
  buyer_id uuid NOT NULL REFERENCES public.profiles(id),
  seller_id uuid NOT NULL REFERENCES public.profiles(id),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  status text NOT NULL DEFAULT 'held' CHECK (status IN ('held','released','refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE INDEX IF NOT EXISTS wallet_escrow_buyer_status_idx ON public.wallet_escrow_holds(buyer_id, status);

ALTER TABLE public.wallet_funding_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_escrow_holds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wallet_funding_owner_select ON public.wallet_funding_intents;
CREATE POLICY wallet_funding_owner_select ON public.wallet_funding_intents
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS wallet_escrow_participant_select ON public.wallet_escrow_holds;
CREATE POLICY wallet_escrow_participant_select ON public.wallet_escrow_holds
  FOR SELECT USING (auth.uid() = buyer_id OR auth.uid() = seller_id);

-- Atomically debit stored value and create a normal transaction in locked state.
CREATE OR REPLACE FUNCTION public.create_wallet_micro_escrow(p_listing_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_buyer uuid := auth.uid();
  v_listing public.listings%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_amount bigint;
  v_balance bigint;
BEGIN
  IF v_buyer IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_listing FROM public.listings WHERE id = p_listing_id AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Listing is not available'; END IF;
  IF v_listing.seller_id = v_buyer THEN RAISE EXCEPTION 'You cannot buy your own listing'; END IF;

  v_amount := v_listing.price;
  IF v_amount > 1000000 THEN RAISE EXCEPTION 'Campus Wallet is only for purchases up to ₦10,000'; END IF;
  IF v_amount <= 0 THEN RAISE EXCEPTION 'Invalid listing amount'; END IF;

  SELECT COALESCE(plug_credit_balance,0) INTO v_balance
    FROM public.profiles WHERE id = v_buyer FOR UPDATE;
  IF v_balance < v_amount THEN RAISE EXCEPTION 'Insufficient Campus Wallet balance'; END IF;

  INSERT INTO public.transactions(listing_id,buyer_id,seller_id,amount,status,payment_method,metadata,payout_status)
  VALUES (p_listing_id,v_buyer,v_listing.seller_id,v_amount,'locked','campus_wallet',jsonb_build_object('wallet_micro_escrow',true),'approved_for_settlement')
  RETURNING * INTO v_tx;

  INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id)
  VALUES (v_buyer,-v_amount,'Campus Wallet escrow hold',v_tx.id);

  INSERT INTO public.wallet_escrow_holds(transaction_id,buyer_id,seller_id,amount_kobo)
  VALUES(v_tx.id,v_buyer,v_listing.seller_id,v_amount);

  RETURN jsonb_build_object('success',true,'transaction_id',v_tx.id,'amount_kobo',v_amount,'wallet_balance_after',v_balance-v_amount);
END; $$;

CREATE OR REPLACE FUNCTION public.resolve_wallet_micro_escrow(p_transaction_id uuid, p_action text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_hold public.wallet_escrow_holds%ROWTYPE;
  v_user uuid := auth.uid();
  v_reason text;
BEGIN
  SELECT * INTO v_hold FROM public.wallet_escrow_holds WHERE transaction_id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Wallet escrow not found'; END IF;
  IF v_user <> v_hold.buyer_id AND v_user <> v_hold.seller_id THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF v_hold.status <> 'held' THEN RAISE EXCEPTION 'Wallet escrow already resolved'; END IF;

  IF p_action = 'release' THEN
    v_reason := 'Campus Wallet micro-escrow release';
    INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id)
      VALUES(v_hold.seller_id,v_hold.amount_kobo,v_reason,v_hold.transaction_id);
    UPDATE public.wallet_escrow_holds SET status='released',resolved_at=now() WHERE id=v_hold.id;
    UPDATE public.transactions SET status='released',released_at=now(),completed_at=now(),payout_status='paid' WHERE id=v_hold.transaction_id;
  ELSIF p_action = 'refund' THEN
    IF v_user <> v_hold.buyer_id THEN RAISE EXCEPTION 'Only the buyer can request a wallet refund'; END IF;
    INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id)
      VALUES(v_hold.buyer_id,v_hold.amount_kobo,'Campus Wallet micro-escrow refund',v_hold.transaction_id);
    UPDATE public.wallet_escrow_holds SET status='refunded',resolved_at=now() WHERE id=v_hold.id;
    UPDATE public.transactions SET status='cancelled',payout_status='not_applicable' WHERE id=v_hold.transaction_id;
  ELSE
    RAISE EXCEPTION 'Invalid wallet escrow action';
  END IF;

  RETURN jsonb_build_object('success',true,'status',p_action);
END; $$;

GRANT EXECUTE ON FUNCTION public.create_wallet_micro_escrow(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_wallet_micro_escrow(uuid,text) TO authenticated;

-- SKU query guardrail: the RPC itself rejects very short/high-cost fuzzy queries.
CREATE OR REPLACE FUNCTION public.match_global_sku(search_title text)
RETURNS SETOF public.global_sku_catalog
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT *
  FROM public.global_sku_catalog
  WHERE length(trim(search_title)) BETWEEN 3 AND 80
  ORDER BY similarity(title, trim(search_title)) DESC
  LIMIT 4;
$$;

GRANT EXECUTE ON FUNCTION public.match_global_sku(text) TO authenticated;
