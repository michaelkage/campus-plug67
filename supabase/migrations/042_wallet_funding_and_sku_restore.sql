-- Migration 042: wallet funding RPC + restore SKU response contract with server guardrails.

CREATE OR REPLACE FUNCTION public.credit_wallet_funding(p_reference text, p_amount_kobo bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_intent public.wallet_funding_intents%ROWTYPE;
BEGIN
  SELECT * INTO v_intent FROM public.wallet_funding_intents WHERE reference=p_reference FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Funding intent not found'; END IF;
  IF v_intent.user_id <> auth.uid() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF v_intent.amount_kobo <> p_amount_kobo THEN RAISE EXCEPTION 'Funding amount mismatch'; END IF;
  IF v_intent.status = 'credited' THEN
    RETURN jsonb_build_object('success',true,'already_credited',true,'amount_kobo',p_amount_kobo);
  END IF;

  INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id)
    VALUES(v_intent.user_id,p_amount_kobo,'Campus Wallet funding',p_reference);
  UPDATE public.wallet_funding_intents SET status='credited',credited_at=now() WHERE id=v_intent.id;
  RETURN jsonb_build_object('success',true,'amount_kobo',p_amount_kobo);
END; $$;
GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(text,bigint) TO authenticated;

-- Preserve the CP-67 MATRIX response shape (including similarity) while rejecting
-- empty/oversized queries before pg_trgm is invoked.
DROP FUNCTION IF EXISTS public.match_global_sku(text);
CREATE OR REPLACE FUNCTION public.match_global_sku(search_title text)
RETURNS TABLE (
  id uuid,
  title text,
  category_id int,
  baseline_lifespan interval,
  lower_price_bound numeric,
  upper_price_bound numeric,
  verified_metadata jsonb,
  similarity real
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Keep NULL handling explicit, while retaining the regression-tested minimum
  -- query-length guard for non-NULL input.
  IF search_title IS NULL THEN
    RETURN;
  END IF;
  IF length(trim(search_title)) < 3 OR length(trim(search_title)) > 80 THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT g.id,g.title,g.category_id,g.baseline_lifespan,g.lower_price_bound,
         g.upper_price_bound,g.verified_metadata,
         similarity(g.title, trim(search_title))::real AS similarity
  FROM public.global_sku_catalog g
  WHERE similarity(g.title, trim(search_title)) > 0.4
  ORDER BY similarity(g.title, trim(search_title)) DESC
  LIMIT 4;
END; $$;
GRANT EXECUTE ON FUNCTION public.match_global_sku(text) TO authenticated;
