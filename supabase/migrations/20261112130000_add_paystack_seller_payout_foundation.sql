-- Seller bank payout foundation. Paystack-funded escrow remains outside PlugCredit.
-- Account numbers are sent to Paystack for verification/recipient creation and
-- are never persisted by Campus Plug. Only the provider recipient code and
-- masked account metadata are stored.

CREATE TABLE IF NOT EXISTS public.seller_payout_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  provider text NOT NULL DEFAULT 'paystack' CHECK (provider = 'paystack'),
  recipient_code text NOT NULL UNIQUE CHECK (recipient_code ~ '^RCP_[A-Za-z0-9]+$'),
  bank_code text NOT NULL CHECK (length(bank_code) BETWEEN 2 AND 12),
  bank_name text NOT NULL CHECK (length(trim(bank_name)) BETWEEN 2 AND 120),
  account_name text NOT NULL CHECK (length(trim(account_name)) BETWEEN 2 AND 160),
  account_last4 text NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  country text NOT NULL DEFAULT 'NG' CHECK (country = 'NG'),
  is_active boolean NOT NULL DEFAULT true,
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS seller_payout_one_active_recipient_per_seller
  ON public.seller_payout_recipients(seller_id)
  WHERE is_active;
CREATE INDEX IF NOT EXISTS seller_payout_recipients_seller_idx
  ON public.seller_payout_recipients(seller_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.seller_payout_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES public.transactions(id) ON DELETE RESTRICT,
  seller_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE RESTRICT,
  recipient_id uuid NOT NULL REFERENCES public.seller_payout_recipients(id) ON DELETE RESTRICT,
  attempt_number smallint NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  reference text NOT NULL UNIQUE CHECK (
    length(reference) BETWEEN 16 AND 50
    AND reference ~ '^[a-z0-9_-]+$'
  ),
  amount_kobo bigint NOT NULL CHECK (amount_kobo > 0),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  status text NOT NULL CHECK (status IN (
    'processing','pending','needs_attention','success',
    'failed','reversed','abandoned','blocked','rejected'
  )),
  provider_transfer_code text,
  provider_transfer_id text,
  provider_status text,
  provider_message text,
  failure_reason text,
  submission_attempts smallint NOT NULL DEFAULT 1 CHECK (submission_attempts BETWEEN 1 AND 10),
  lease_expires_at timestamptz,
  initiated_at timestamptz,
  completed_at timestamptz,
  last_reconciled_at timestamptz,
  earnings_reversed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id, attempt_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS seller_payout_transfer_code_uidx
  ON public.seller_payout_transfers(provider_transfer_code)
  WHERE provider_transfer_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS seller_payout_transfers_reconcile_idx
  ON public.seller_payout_transfers(status, updated_at)
  WHERE status IN ('processing','pending');
CREATE INDEX IF NOT EXISTS seller_payout_transfers_transaction_idx
  ON public.seller_payout_transfers(transaction_id, attempt_number DESC);

ALTER TABLE public.seller_payout_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.seller_payout_transfers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.seller_payout_recipients FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.seller_payout_transfers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seller_payout_recipients TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seller_payout_transfers TO service_role;

CREATE OR REPLACE FUNCTION public.save_seller_payout_recipient(
  p_seller_id uuid,
  p_recipient_code text,
  p_bank_code text,
  p_bank_name text,
  p_account_name text,
  p_account_last4 text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_recipient public.seller_payout_recipients%ROWTYPE;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF p_seller_id IS NULL
     OR p_recipient_code !~ '^RCP_[A-Za-z0-9]+$'
     OR p_bank_code IS NULL OR length(p_bank_code) NOT BETWEEN 2 AND 12
     OR p_bank_name IS NULL OR length(trim(p_bank_name)) NOT BETWEEN 2 AND 120
     OR p_account_name IS NULL OR length(trim(p_account_name)) NOT BETWEEN 2 AND 160
     OR p_account_last4 !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'Verified Nigerian payout recipient details are invalid';
  END IF;

  PERFORM 1 FROM public.profiles WHERE id = p_seller_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Seller profile not found'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.seller_payout_recipients
    WHERE recipient_code = p_recipient_code AND seller_id <> p_seller_id
  ) THEN
    RAISE EXCEPTION 'Paystack recipient is already assigned to another seller';
  END IF;

  UPDATE public.seller_payout_recipients
     SET is_active = false, updated_at = now()
   WHERE seller_id = p_seller_id AND is_active
     AND recipient_code <> p_recipient_code;

  INSERT INTO public.seller_payout_recipients (
    seller_id, recipient_code, bank_code, bank_name,
    account_name, account_last4, currency, country,
    is_active, verified_at, updated_at
  ) VALUES (
    p_seller_id, p_recipient_code, p_bank_code, trim(p_bank_name),
    trim(p_account_name), p_account_last4, 'NGN', 'NG',
    true, now(), now()
  )
  ON CONFLICT (recipient_code) DO UPDATE
    SET bank_code = EXCLUDED.bank_code,
        bank_name = EXCLUDED.bank_name,
        account_name = EXCLUDED.account_name,
        account_last4 = EXCLUDED.account_last4,
        is_active = true,
        verified_at = now(),
        updated_at = now()
    WHERE public.seller_payout_recipients.seller_id = EXCLUDED.seller_id
  RETURNING * INTO v_recipient;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Could not securely assign Paystack payout recipient';
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'recipient_id', v_recipient.id,
    'bank_name', v_recipient.bank_name,
    'account_name', v_recipient.account_name,
    'account_last4', v_recipient.account_last4,
    'currency', v_recipient.currency,
    'verified_at', v_recipient.verified_at
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_seller_payout_transfers(p_limit integer DEFAULT 10)
RETURNS TABLE (
  transfer_id uuid,
  transaction_id uuid,
  seller_id uuid,
  recipient_code text,
  amount_kobo bigint,
  currency text,
  reference text,
  attempt_number smallint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_recipient public.seller_payout_recipients%ROWTYPE;
  v_transfer public.seller_payout_transfers%ROWTYPE;
  v_last public.seller_payout_transfers%ROWTYPE;
  v_attempt smallint;
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 10), 1), 25);
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;

  FOR v_tx IN
    SELECT t.*
      FROM public.transactions AS t
     WHERE t.status IN ('released', 'completed')
       AND t.payment_verified IS TRUE
       AND COALESCE(t.payment_method, 'paystack') <> 'campus_wallet'
       AND t.paystack_ref IS NOT NULL
       AND t.amount > 0
       AND t.payout_status IN ('approved_for_settlement', 'failed', 'processing')
       AND COALESCE(t.refund_status, '') NOT IN (
         'pending','processing','needs-attention','needs_attention','processed'
       )
       AND EXISTS (
         SELECT 1 FROM public.seller_payout_recipients AS recipient
          WHERE recipient.seller_id = t.seller_id AND recipient.is_active
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.jury_cases AS dispute
          WHERE dispute.transaction_id = t.id
            AND dispute.status NOT IN ('closed','decided')
       )
     ORDER BY COALESCE(t.payout_approved_at, t.released_at, t.updated_at), t.id
     FOR UPDATE OF t SKIP LOCKED
     LIMIT v_limit
  LOOP
    SELECT * INTO v_recipient
      FROM public.seller_payout_recipients
     WHERE seller_id = v_tx.seller_id AND is_active
     ORDER BY updated_at DESC
     LIMIT 1
     FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    SELECT * INTO v_last
      FROM public.seller_payout_transfers
     WHERE transaction_id = v_tx.id
     ORDER BY attempt_number DESC
     LIMIT 1
     FOR UPDATE;

    IF FOUND THEN
      IF v_last.status = 'processing' AND v_last.lease_expires_at <= now()
         AND v_last.submission_attempts < 10 THEN
        UPDATE public.seller_payout_transfers
           SET submission_attempts = submission_attempts + 1,
               lease_expires_at = now() + interval '3 minutes',
               updated_at = now()
         WHERE id = v_last.id
        RETURNING * INTO v_transfer;
      ELSIF v_last.status IN ('failed','reversed')
         AND v_last.attempt_number < 3
         AND v_last.updated_at <= now() - (interval '5 minutes' * v_last.attempt_number) THEN
        v_attempt := v_last.attempt_number + 1;
        INSERT INTO public.seller_payout_transfers (
          transaction_id, seller_id, recipient_id, attempt_number,
          reference, amount_kobo, currency, status, submission_attempts,
          lease_expires_at, initiated_at
        ) VALUES (
          v_tx.id, v_tx.seller_id, v_recipient.id, v_attempt,
          'cp_tr_' || replace(gen_random_uuid()::text, '-', ''),
          v_tx.amount, 'NGN', 'processing', 1, now() + interval '3 minutes', now()
        )
        RETURNING * INTO v_transfer;
      ELSE
        CONTINUE;
      END IF;
    ELSE
      v_attempt := 1;
      INSERT INTO public.seller_payout_transfers (
        transaction_id, seller_id, recipient_id, attempt_number,
        reference, amount_kobo, currency, status, submission_attempts,
        lease_expires_at, initiated_at
      ) VALUES (
        v_tx.id, v_tx.seller_id, v_recipient.id, v_attempt,
        'cp_tr_' || replace(gen_random_uuid()::text, '-', ''),
        v_tx.amount, 'NGN', 'processing', 1, now() + interval '3 minutes', now()
      )
      RETURNING * INTO v_transfer;
    END IF;

    -- A claimed transfer is bound to the recipient captured on that attempt.
    -- Changing a seller's active bank account must never redirect an in-flight
    -- provider reference to a different beneficiary.
    SELECT * INTO v_recipient
      FROM public.seller_payout_recipients
     WHERE id = v_transfer.recipient_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payout recipient snapshot is missing'; END IF;

    UPDATE public.transactions
       SET payout_status = 'processing',
           payout_reference = v_transfer.reference,
           payout_failure_reason = NULL
     WHERE id = v_tx.id;

    transfer_id := v_transfer.id;
    transaction_id := v_transfer.transaction_id;
    seller_id := v_transfer.seller_id;
    recipient_code := v_recipient.recipient_code;
    amount_kobo := v_transfer.amount_kobo;
    currency := v_transfer.currency;
    reference := v_transfer.reference;
    attempt_number := v_transfer.attempt_number;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_paystack_transfer(
  p_reference text,
  p_status text,
  p_amount bigint,
  p_currency text,
  p_recipient_code text,
  p_transfer_code text DEFAULT NULL,
  p_provider_transfer_id text DEFAULT NULL,
  p_message text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_transfer public.seller_payout_transfers%ROWTYPE;
  v_recipient public.seller_payout_recipients%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_status text := lower(COALESCE(p_status, ''));
  v_previous_status text;
BEGIN
  IF COALESCE(auth.jwt() ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service role required';
  END IF;
  IF v_status NOT IN ('pending','success','failed','reversed','otp','needs_attention','abandoned','blocked','rejected','received') THEN
    RAISE EXCEPTION 'Unsupported Paystack transfer status';
  END IF;
  IF p_reference IS NULL OR p_amount IS NULL OR p_amount <= 0
     OR upper(COALESCE(p_currency, '')) <> 'NGN'
     OR p_recipient_code IS NULL THEN
    RAISE EXCEPTION 'Paystack transfer event is missing required financial fields';
  END IF;

  SELECT * INTO v_transfer
    FROM public.seller_payout_transfers
   WHERE reference = p_reference
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown Paystack transfer reference'; END IF;

  SELECT * INTO v_tx
    FROM public.transactions
   WHERE id = v_transfer.transaction_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout transaction not found'; END IF;

  SELECT * INTO v_recipient
    FROM public.seller_payout_recipients
   WHERE id = v_transfer.recipient_id;
  IF NOT FOUND
     OR v_recipient.recipient_code <> p_recipient_code
     OR v_transfer.seller_id <> v_tx.seller_id
     OR v_transfer.amount_kobo <> p_amount
     OR v_tx.amount <> p_amount
     OR v_transfer.currency <> upper(p_currency)
     OR v_tx.payment_verified IS DISTINCT FROM true
     OR v_tx.status NOT IN ('released','completed')
     OR COALESCE(v_tx.payment_method, 'paystack') = 'campus_wallet' THEN
    RAISE EXCEPTION 'Paystack transfer does not match the approved escrow payout';
  END IF;

  v_previous_status := v_transfer.status;

  -- Provider events can be delivered late or out of order. Never downgrade a
  -- conclusive state, except that a real reversal must undo a prior success.
  IF v_previous_status = 'success' AND v_status <> 'reversed' THEN
    RETURN jsonb_build_object('success', true, 'duplicate_or_stale', true, 'status', v_previous_status);
  END IF;
  IF v_previous_status IN ('failed','reversed','abandoned','blocked','rejected')
     AND v_status <> v_previous_status THEN
    RETURN jsonb_build_object('success', true, 'duplicate_or_stale', true, 'status', v_previous_status);
  END IF;

  IF v_status = 'success' THEN
    UPDATE public.seller_payout_transfers
       SET status = 'success',
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = p_message,
           failure_reason = NULL,
           lease_expires_at = NULL,
           completed_at = COALESCE(completed_at, now()),
           updated_at = now()
     WHERE id = v_transfer.id;

    UPDATE public.transactions
       SET payout_status = 'paid',
           payout_reference = v_transfer.reference,
           payout_failure_reason = NULL
     WHERE id = v_tx.id;
  ELSIF v_status = 'reversed' THEN
    UPDATE public.seller_payout_transfers
       SET status = 'reversed',
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = p_message,
           failure_reason = COALESCE(p_message, 'Paystack reversed the transfer'),
           lease_expires_at = NULL,
           completed_at = COALESCE(completed_at, now()),
           earnings_reversed_at = CASE WHEN v_previous_status = 'success' THEN COALESCE(earnings_reversed_at, now()) ELSE earnings_reversed_at END,
           updated_at = now()
     WHERE id = v_transfer.id;

    IF v_previous_status = 'success' AND v_transfer.earnings_reversed_at IS NULL THEN
      UPDATE public.profiles
         SET total_earnings = GREATEST(COALESCE(total_earnings, 0) - v_tx.amount, 0)
       WHERE id = v_tx.seller_id;
    END IF;

    UPDATE public.transactions
       SET payout_status = 'failed',
           payout_reference = v_transfer.reference,
           payout_failure_reason = 'Paystack transfer reversed: ' || COALESCE(p_message, 'funds returned to merchant balance')
     WHERE id = v_tx.id;
  ELSIF v_status IN ('failed','abandoned','blocked','rejected') THEN
    UPDATE public.seller_payout_transfers
       SET status = v_status,
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = p_message,
           failure_reason = COALESCE(p_message, 'Paystack transfer did not complete'),
           lease_expires_at = NULL,
           completed_at = now(),
           updated_at = now()
     WHERE id = v_transfer.id;

    UPDATE public.transactions
       SET payout_status = 'failed',
           payout_reference = v_transfer.reference,
           payout_failure_reason = COALESCE(p_message, 'Paystack transfer ' || v_status)
     WHERE id = v_tx.id;
  ELSE
    UPDATE public.seller_payout_transfers
       SET status = CASE WHEN v_status IN ('otp','needs_attention') THEN 'needs_attention' ELSE 'pending' END,
           provider_status = v_status,
           provider_transfer_code = COALESCE(p_transfer_code, provider_transfer_code),
           provider_transfer_id = COALESCE(p_provider_transfer_id, provider_transfer_id),
           provider_message = p_message,
           lease_expires_at = NULL,
           updated_at = now()
     WHERE id = v_transfer.id;

    UPDATE public.transactions
       SET payout_status = 'processing',
           payout_reference = v_transfer.reference,
           payout_failure_reason = CASE WHEN v_status = 'otp' THEN 'Paystack transfer requires merchant OTP approval' WHEN v_status = 'needs_attention' THEN COALESCE(p_message, 'Paystack transfer requires manual reconciliation') ELSE NULL END
     WHERE id = v_tx.id;
  END IF;

  RETURN jsonb_build_object('success', true, 'status', CASE WHEN v_status IN ('otp','needs_attention') THEN 'needs_attention' ELSE v_status END, 'transaction_id', v_tx.id);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_seller_payout_recipient(uuid,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_seller_payout_transfers(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_paystack_transfer(text,text,bigint,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_seller_payout_recipient(uuid,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_seller_payout_transfers(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_paystack_transfer(text,text,bigint,text,text,text,text,text) TO service_role;

COMMENT ON TABLE public.seller_payout_recipients IS
  'Verified Paystack transfer recipients. Stores recipient code and masked metadata only; never stores bank account numbers.';
COMMENT ON TABLE public.seller_payout_transfers IS
  'Append-only-per-attempt Paystack transfer lifecycle. Every retry after a conclusive failure receives a new reference.';
