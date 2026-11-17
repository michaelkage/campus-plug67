-- Migration 036: Authoritative Dispute Resolution & Strict Escrow Payouts
-- Resolves ledger divergence where jury dispute verdicts failed to update plug_credit_ledger.

CREATE OR REPLACE FUNCTION public.resolve_dispute_verdict(
  p_case_id uuid,
  p_verdict text,
  p_admin_override boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_case public.jury_cases%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_recipient uuid;
  v_reason text;
BEGIN
  -- 1. Security check
  IF NOT p_admin_override AND auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'Only service_role or admin can execute resolve_dispute_verdict';
  END IF;

  -- 2. Row locking
  SELECT * INTO v_case FROM public.jury_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN 
    RAISE EXCEPTION 'Jury case % not found', p_case_id; 
  END IF;

  IF v_case.status IN ('closed', 'decided') THEN
    RETURN jsonb_build_object('success', true, 'already_resolved', true);
  END IF;

  SELECT * INTO v_tx FROM public.transactions WHERE id = v_case.transaction_id FOR UPDATE;
  IF NOT FOUND THEN 
    RAISE EXCEPTION 'Associated transaction % not found', v_case.transaction_id; 
  END IF;

  -- 3. Determine payout recipient
  IF p_verdict = 'claimant' THEN
    v_recipient := v_tx.buyer_id;
    v_reason := 'Dispute refund: settled in favour of buyer';
    
    UPDATE public.transactions
    SET status = 'cancelled',
        cancelled_at = now(),
        updated_at = now()
    WHERE id = v_tx.id;

    UPDATE public.profiles
    SET plug_score = greatest(COALESCE(plug_score, 500) - 50, 0)
    WHERE id = v_tx.seller_id;

  ELSIF p_verdict = 'respondent' THEN
    v_recipient := v_tx.seller_id;
    v_reason := 'Dispute settlement: released to seller';

    UPDATE public.transactions
    SET status = 'released',
        released_at = now(),
        completed_at = now(),
        updated_at = now()
    WHERE id = v_tx.id;

  ELSE
    RAISE EXCEPTION 'Invalid verdict %. Must be claimant or respondent', p_verdict;
  END IF;

  -- 4. Authoritative Ledger Entry (Triggers profile balance calculation automatically)
  INSERT INTO public.plug_credit_ledger (
    user_id,
    amount,
    reason,
    reference_id
  ) VALUES (
    v_recipient,
    v_tx.amount,
    v_reason,
    v_tx.id
  ) ON CONFLICT (reference_id, reason) DO NOTHING;

  -- 5. Finalize jury case
  UPDATE public.jury_cases
  SET status = 'decided',
      verdict = p_verdict,
      verdict_decided_at = now()
  WHERE id = v_case.id;

  -- 6. Audit logging
  INSERT INTO public.audit_logs (
    entity_type,
    entity_id,
    user_id,
    action,
    metadata
  ) VALUES (
    'jury_case',
    v_case.id,
    COALESCE(auth.uid(), v_tx.seller_id),
    'dispute_resolved',
    jsonb_build_object(
      'verdict', p_verdict,
      'transaction_id', v_tx.id,
      'amount', v_tx.amount,
      'recipient', v_recipient
    )
  );

  RETURN jsonb_build_object(
    'success', true,
    'case_id', v_case.id,
    'transaction_id', v_tx.id,
    'verdict', p_verdict,
    'recipient', v_recipient,
    'amount', v_tx.amount
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_dispute_verdict(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_dispute_verdict(uuid, text, boolean) TO service_role;

-- ---------------------------------------------------------------------------
-- Dedicated Auth Challenges table to resolve WebAuthn challenge stranding
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.auth_challenges (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  challenge_type text NOT NULL CHECK (challenge_type IN ('reg', 'auth')),
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, challenge_type)
);

ALTER TABLE public.auth_challenges ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service manages auth challenges" ON public.auth_challenges;
CREATE POLICY "Service manages auth challenges" ON public.auth_challenges
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS auth_challenges_expires_idx ON public.auth_challenges (expires_at);

