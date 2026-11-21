-- Milestone 4, slice 2: canonical, immutable, balanced double-entry journal.
--
-- financial_ledger remains the compatibility per-user wallet projection.
-- These journal tables become the accounting source of truth for supported
-- NGN events. Existing balances and provider/webhook records are not rewritten.
--
-- Account model:
--   asset.paystack_clearing       Paystack merchant settlement control
--   asset.seller_recovery         seller receivable after a post-payout refund
--   liability.user_wallet        individual Campus Wallet liability
--   liability.escrow              transaction-specific escrow liability
--   liability.seller_payable      individual seller settlement liability
--
-- All amounts are integer kobo. Every posted journal transaction is balanced.

CREATE TABLE IF NOT EXISTS public.financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_code text NOT NULL,
  account_type text NOT NULL CHECK (account_type IN ('asset','liability','equity','revenue','expense')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('debit','credit')),
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  owner_id uuid,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(account_code)) BETWEEN 3 AND 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_system_code_uidx
  ON public.financial_accounts(account_code, currency)
  WHERE owner_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_owner_code_uidx
  ON public.financial_accounts(account_code, owner_id, currency)
  WHERE owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.financial_journal_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  source text NOT NULL,
  reference_type text,
  reference_id uuid,
  idempotency_key text NOT NULL UNIQUE,
  currency text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  amount bigint NOT NULL CHECK (amount > 0),
  line_payload jsonb NOT NULL CHECK (jsonb_typeof(line_payload) = 'array'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  posted_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(event_type)) > 0),
  CHECK (length(trim(source)) > 0),
  CHECK (length(trim(idempotency_key)) BETWEEN 1 AND 240)
);

CREATE TABLE IF NOT EXISTS public.financial_journal_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_transaction_id uuid NOT NULL REFERENCES public.financial_journal_transactions(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES public.financial_accounts(id) ON DELETE RESTRICT,
  debit bigint NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit bigint NOT NULL DEFAULT 0 CHECK (credit >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0))
);

CREATE INDEX IF NOT EXISTS financial_journal_entries_account_idx
  ON public.financial_journal_entries(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS financial_journal_entries_transaction_idx
  ON public.financial_journal_entries(journal_transaction_id);

CREATE OR REPLACE VIEW public.financial_journal_trial_balance
WITH (security_invoker = true)
AS
SELECT
  t.currency,
  COALESCE(sum(e.debit),0)::bigint AS total_debits,
  COALESCE(sum(e.credit),0)::bigint AS total_credits,
  (COALESCE(sum(e.debit),0) - COALESCE(sum(e.credit),0))::bigint AS imbalance
FROM public.financial_journal_transactions t
JOIN public.financial_journal_entries e ON e.journal_transaction_id = t.id
GROUP BY t.currency;

REVOKE ALL ON public.financial_journal_trial_balance FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.financial_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_journal_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.financial_journal_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.financial_accounts, public.financial_journal_transactions,
  public.financial_journal_entries FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_financial_account_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF NEW.account_code IS DISTINCT FROM OLD.account_code
     OR NEW.account_type IS DISTINCT FROM OLD.account_type
     OR NEW.normal_balance IS DISTINCT FROM OLD.normal_balance
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Financial account identity is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS financial_accounts_identity_guard ON public.financial_accounts;
CREATE TRIGGER financial_accounts_identity_guard
BEFORE UPDATE ON public.financial_accounts
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_account_identity();

CREATE OR REPLACE FUNCTION public.guard_financial_journal_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Financial journal records are immutable; post a compensating journal transaction';
END;
$function$;

DROP TRIGGER IF EXISTS financial_journal_transactions_append_only ON public.financial_journal_transactions;
CREATE TRIGGER financial_journal_transactions_append_only
BEFORE UPDATE OR DELETE ON public.financial_journal_transactions
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_journal_append_only();

DROP TRIGGER IF EXISTS financial_journal_entries_append_only ON public.financial_journal_entries;
CREATE TRIGGER financial_journal_entries_append_only
BEFORE UPDATE OR DELETE ON public.financial_journal_entries
FOR EACH ROW EXECUTE FUNCTION public.guard_financial_journal_append_only();

CREATE OR REPLACE FUNCTION public.get_financial_account_id(
  p_account_code text,
  p_account_type text,
  p_normal_balance text,
  p_owner_id uuid DEFAULT NULL,
  p_description text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_currency text := 'NGN';
BEGIN
  IF p_account_code IS NULL OR p_account_type NOT IN ('asset','liability','equity','revenue','expense')
     OR p_normal_balance NOT IN ('debit','credit') THEN
    RAISE EXCEPTION 'Invalid financial account definition';
  END IF;

  IF p_owner_id IS NULL THEN
    INSERT INTO public.financial_accounts(account_code, account_type, normal_balance, currency, owner_id, description)
    VALUES (p_account_code, p_account_type, p_normal_balance, v_currency, NULL, COALESCE(p_description, p_account_code))
    ON CONFLICT (account_code, currency) WHERE owner_id IS NULL DO NOTHING;
    SELECT id INTO v_id FROM public.financial_accounts
     WHERE account_code = p_account_code AND currency = v_currency AND owner_id IS NULL;
  ELSE
    INSERT INTO public.financial_accounts(account_code, account_type, normal_balance, currency, owner_id, description)
    VALUES (p_account_code, p_account_type, p_normal_balance, v_currency, p_owner_id, COALESCE(p_description, p_account_code))
    ON CONFLICT (account_code, owner_id, currency) WHERE owner_id IS NOT NULL DO NOTHING;
    SELECT id INTO v_id FROM public.financial_accounts
     WHERE account_code = p_account_code AND currency = v_currency AND owner_id = p_owner_id;
  END IF;

  IF NOT FOUND OR v_id IS NULL THEN
    RAISE EXCEPTION 'Could not resolve financial account %', p_account_code;
  END IF;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_financial_journal_transaction(
  p_event_type text,
  p_source text,
  p_reference_type text,
  p_reference_id uuid,
  p_idempotency_key text,
  p_lines jsonb,
  p_metadata jsonb DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_total_debit bigint;
  v_total_credit bigint;
  v_journal_id uuid;
  v_existing public.financial_journal_transactions%ROWTYPE;
  v_line jsonb;
  v_account public.financial_accounts%ROWTYPE;
  v_debit bigint;
  v_credit bigint;
BEGIN
  IF p_event_type IS NULL OR length(trim(p_event_type)) = 0
     OR p_source IS NULL OR length(trim(p_source)) = 0
     OR p_idempotency_key IS NULL OR length(trim(p_idempotency_key)) = 0
     OR length(p_idempotency_key) > 240
     OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'Journal transaction is missing required fields or posting lines';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_lines) AS line
     WHERE NOT (line ? 'account_id')
        OR COALESCE(line->>'account_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR COALESCE(line->>'debit','') !~ '^[0-9]+$'
        OR COALESCE(line->>'credit','') !~ '^[0-9]+$'
  ) THEN
    RAISE EXCEPTION 'Journal lines must contain valid account IDs and non-negative integer debit/credit values';
  END IF;

  SELECT sum((line->>'debit')::bigint), sum((line->>'credit')::bigint)
    INTO v_total_debit, v_total_credit
    FROM jsonb_array_elements(p_lines) AS line;

  IF (SELECT count(DISTINCT (line->>'account_id')::uuid)
        FROM jsonb_array_elements(p_lines) AS line) < 2 THEN
    RAISE EXCEPTION 'A balanced journal must affect at least two distinct accounts';
  END IF;

  IF v_total_debit IS NULL OR v_total_debit <= 0
     OR v_total_debit IS DISTINCT FROM v_total_credit THEN
    RAISE EXCEPTION 'Unbalanced financial journal: debits %, credits %', v_total_debit, v_total_credit;
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines)
  LOOP
    v_debit := (v_line->>'debit')::bigint;
    v_credit := (v_line->>'credit')::bigint;
    IF (v_debit > 0 AND v_credit > 0) OR (v_debit = 0 AND v_credit = 0) THEN
      RAISE EXCEPTION 'Each journal line must have exactly one positive side';
    END IF;

    SELECT * INTO v_account
      FROM public.financial_accounts
     WHERE id = (v_line->>'account_id')::uuid
     FOR SHARE;
    IF NOT FOUND OR v_account.currency <> 'NGN' THEN
      RAISE EXCEPTION 'Journal line references a missing or unsupported account';
    END IF;
  END LOOP;

  INSERT INTO public.financial_journal_transactions(
    event_type, source, reference_type, reference_id, idempotency_key,
    currency, amount, line_payload, metadata
  ) VALUES (
    trim(p_event_type), trim(p_source), p_reference_type, p_reference_id,
    trim(p_idempotency_key), 'NGN', v_total_debit, p_lines, COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_journal_id;

  IF v_journal_id IS NULL THEN
    SELECT * INTO v_existing
      FROM public.financial_journal_transactions
     WHERE idempotency_key = trim(p_idempotency_key)
     FOR UPDATE;

    IF NOT FOUND
       OR v_existing.event_type IS DISTINCT FROM trim(p_event_type)
       OR v_existing.source IS DISTINCT FROM trim(p_source)
       OR v_existing.reference_type IS DISTINCT FROM p_reference_type
       OR v_existing.reference_id IS DISTINCT FROM p_reference_id
       OR v_existing.amount IS DISTINCT FROM v_total_debit
       OR v_existing.line_payload IS DISTINCT FROM p_lines
       OR v_existing.metadata IS DISTINCT FROM COALESCE(p_metadata, '{}'::jsonb) THEN
      RAISE EXCEPTION 'Journal idempotency key reused with a different financial payload';
    END IF;
    RETURN v_existing.id;
  END IF;

  INSERT INTO public.financial_journal_entries(
    journal_transaction_id, account_id, debit, credit
  )
  SELECT
    v_journal_id,
    (line->>'account_id')::uuid,
    (line->>'debit')::bigint,
    (line->>'credit')::bigint
  FROM jsonb_array_elements(p_lines) AS line;

  RETURN v_journal_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_financial_account_id(text,text,text,uuid,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_financial_journal_transaction(text,text,text,uuid,text,jsonb,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.post_wallet_financial_journal_entry(
  p_entry public.financial_ledger
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_reason text := p_entry.metadata->>'legacy_reason';
  v_reference_id uuid := NULLIF(p_entry.metadata->>'legacy_reference_id','')::uuid;
  v_wallet_account uuid;
  v_counter_account uuid;
  v_lines jsonb;
  v_tx public.transactions%ROWTYPE;
BEGIN
  IF p_entry.source <> 'plug_credit_ledger' THEN RETURN; END IF;

  v_wallet_account := public.get_financial_account_id(
    'liability.user_wallet','liability','credit',p_entry.user_id,
    'Campus Wallet liability for user ' || p_entry.user_id::text
  );

  CASE v_reason
    WHEN 'Campus Wallet funding' THEN
      v_counter_account := public.get_financial_account_id(
        'asset.paystack_clearing','asset','debit',NULL,'Paystack merchant clearing control'
      );
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id',v_counter_account,'debit',p_entry.amount,'credit',0),
        jsonb_build_object('account_id',v_wallet_account,'debit',0,'credit',p_entry.amount)
      );

    WHEN 'Campus Wallet escrow hold' THEN
      IF v_reference_id IS NULL THEN RAISE EXCEPTION 'Wallet escrow hold is missing its transaction reference'; END IF;
      v_counter_account := public.get_financial_account_id(
        'liability.escrow','liability','credit',v_reference_id,'Escrow liability for transaction ' || v_reference_id::text
      );
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id',v_wallet_account,'debit',p_entry.amount,'credit',0),
        jsonb_build_object('account_id',v_counter_account,'debit',0,'credit',p_entry.amount)
      );

    WHEN 'Campus Wallet micro-escrow release' THEN
      IF v_reference_id IS NULL THEN RAISE EXCEPTION 'Wallet escrow release is missing its transaction reference'; END IF;
      SELECT * INTO v_tx FROM public.transactions WHERE id = v_reference_id FOR SHARE;
      IF NOT FOUND OR v_tx.seller_id <> p_entry.user_id THEN
        RAISE EXCEPTION 'Wallet escrow release does not match the transaction seller';
      END IF;
      v_counter_account := public.get_financial_account_id(
        'liability.escrow','liability','credit',v_reference_id,'Escrow liability for transaction ' || v_reference_id::text
      );
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id',v_counter_account,'debit',p_entry.amount,'credit',0),
        jsonb_build_object('account_id',v_wallet_account,'debit',0,'credit',p_entry.amount)
      );

    WHEN 'Campus Wallet micro-escrow refund' THEN
      IF v_reference_id IS NULL THEN RAISE EXCEPTION 'Wallet escrow refund is missing its transaction reference'; END IF;
      SELECT * INTO v_tx FROM public.transactions WHERE id = v_reference_id FOR SHARE;
      IF NOT FOUND OR v_tx.buyer_id <> p_entry.user_id THEN
        RAISE EXCEPTION 'Wallet escrow refund does not match the transaction buyer';
      END IF;
      v_counter_account := public.get_financial_account_id(
        'liability.escrow','liability','credit',v_reference_id,'Escrow liability for transaction ' || v_reference_id::text
      );
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id',v_counter_account,'debit',p_entry.amount,'credit',0),
        jsonb_build_object('account_id',v_wallet_account,'debit',0,'credit',p_entry.amount)
      );

    ELSE
      -- Unknown historical wallet reasons remain visible in financial_ledger
      -- and are intentionally not assigned a fictional accounting counterpart.
      RETURN;
  END CASE;

  PERFORM public.post_financial_journal_transaction(
    'wallet.' || lower(replace(v_reason,' ','_')),
    'financial_ledger',
    'financial_ledger',
    p_entry.id,
    'financial-ledger:' || p_entry.id::text,
    v_lines,
    jsonb_build_object(
      'legacy_reason',v_reason,
      'legacy_reference_id',v_reference_id,
      'user_id',p_entry.user_id,
      'legacy_source',p_entry.source
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.post_financial_ledger_to_journal_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.post_wallet_financial_journal_entry(NEW);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_wallet_financial_journal_entry(public.financial_ledger)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.post_financial_ledger_to_journal_trigger()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS financial_ledger_double_entry_posting ON public.financial_ledger;
CREATE TRIGGER financial_ledger_double_entry_posting
AFTER INSERT ON public.financial_ledger
FOR EACH ROW EXECUTE FUNCTION public.post_financial_ledger_to_journal_trigger();

CREATE OR REPLACE FUNCTION public.post_paystack_transaction_journal_event(
  p_transaction public.transactions,
  p_event text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_escrow_account uuid;
  v_counter_account uuid;
  v_lines jsonb;
  v_release_exists boolean;
  v_idempotency_key text;
BEGIN
  IF p_transaction.id IS NULL OR p_transaction.payment_verified IS DISTINCT FROM true
     OR COALESCE(p_transaction.payment_method,'paystack') = 'campus_wallet'
     OR p_transaction.amount IS NULL OR p_transaction.amount <= 0 THEN
    RETURN;
  END IF;

  v_escrow_account := public.get_financial_account_id(
    'liability.escrow','liability','credit',p_transaction.id,
    'Escrow liability for transaction ' || p_transaction.id::text
  );
  v_counter_account := public.get_financial_account_id(
    'asset.paystack_clearing','asset','debit',NULL,'Paystack merchant clearing control'
  );

  IF p_event = 'funded' THEN
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id',v_counter_account,'debit',p_transaction.amount,'credit',0),
      jsonb_build_object('account_id',v_escrow_account,'debit',0,'credit',p_transaction.amount)
    );
    v_idempotency_key := 'paystack-escrow-funded:' || p_transaction.id::text;

  ELSIF p_event = 'released' THEN
    IF p_transaction.status NOT IN ('released','completed') THEN RETURN; END IF;
    v_counter_account := public.get_financial_account_id(
      'liability.seller_payable','liability','credit',p_transaction.seller_id,
      'Seller payout payable for user ' || p_transaction.seller_id::text
    );
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id',v_escrow_account,'debit',p_transaction.amount,'credit',0),
      jsonb_build_object('account_id',v_counter_account,'debit',0,'credit',p_transaction.amount)
    );
    v_idempotency_key := 'paystack-escrow-released:' || p_transaction.id::text;

  ELSIF p_event = 'refunded' THEN
    IF p_transaction.refund_status IS DISTINCT FROM 'processed' THEN RETURN; END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.financial_journal_transactions
       WHERE idempotency_key = 'paystack-escrow-released:' || p_transaction.id::text
    ) INTO v_release_exists;

    IF NOT v_release_exists THEN
      v_counter_account := v_escrow_account;
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id',v_counter_account,'debit',p_transaction.amount,'credit',0),
        jsonb_build_object('account_id',public.get_financial_account_id(
          'asset.paystack_clearing','asset','debit',NULL,'Paystack merchant clearing control'
        ),'debit',0,'credit',p_transaction.amount)
      );
    ELSIF p_transaction.payout_status = 'paid' THEN
      v_counter_account := public.get_financial_account_id(
        'asset.seller_recovery','asset','debit',NULL,'Seller recovery receivable after a post-payout refund'
      );
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id',v_counter_account,'debit',p_transaction.amount,'credit',0),
        jsonb_build_object('account_id',public.get_financial_account_id(
          'asset.paystack_clearing','asset','debit',NULL,'Paystack merchant clearing control'
        ),'debit',0,'credit',p_transaction.amount)
      );
    ELSE
      v_counter_account := public.get_financial_account_id(
        'liability.seller_payable','liability','credit',p_transaction.seller_id,
        'Seller payout payable for user ' || p_transaction.seller_id::text
      );
      v_lines := jsonb_build_array(
        jsonb_build_object('account_id',v_counter_account,'debit',p_transaction.amount,'credit',0),
        jsonb_build_object('account_id',public.get_financial_account_id(
          'asset.paystack_clearing','asset','debit',NULL,'Paystack merchant clearing control'
        ),'debit',0,'credit',p_transaction.amount)
      );
    END IF;
    v_idempotency_key := 'paystack-escrow-refunded:' || p_transaction.id::text;
  ELSE
    RAISE EXCEPTION 'Unsupported Paystack transaction journal event: %',p_event;
  END IF;

  PERFORM public.post_financial_journal_transaction(
    'paystack.escrow.' || p_event,
    'transactions',
    'transaction',
    p_transaction.id,
    v_idempotency_key,
    v_lines,
    jsonb_build_object(
      'transaction_id',p_transaction.id,
      'seller_id',p_transaction.seller_id,
      'buyer_id',p_transaction.buyer_id,
      'payment_method',p_transaction.payment_method,
      'payout_status',p_transaction.payout_status,
      'refund_status',p_transaction.refund_status
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.sync_paystack_transaction_to_financial_journal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.payment_verified IS TRUE
     AND (TG_OP = 'INSERT' OR OLD.payment_verified IS DISTINCT FROM true) THEN
    PERFORM public.post_paystack_transaction_journal_event(NEW,'funded');
  END IF;

  IF NEW.status IN ('released','completed')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('released','completed'))
     AND NEW.payment_verified IS TRUE
     AND COALESCE(NEW.payment_method,'paystack') <> 'campus_wallet' THEN
    PERFORM public.post_paystack_transaction_journal_event(NEW,'released');
  END IF;

  IF NEW.refund_status = 'processed'
     AND (TG_OP = 'INSERT' OR OLD.refund_status IS DISTINCT FROM 'processed')
     AND NEW.payment_verified IS TRUE
     AND COALESCE(NEW.payment_method,'paystack') <> 'campus_wallet' THEN
    PERFORM public.post_paystack_transaction_journal_event(NEW,'refunded');
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.post_paystack_transaction_journal_event(public.transactions,text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.sync_paystack_transaction_to_financial_journal()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS transactions_financial_journal_sync ON public.transactions;
CREATE TRIGGER transactions_financial_journal_sync
AFTER INSERT OR UPDATE OF payment_verified, status, refund_status
ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.sync_paystack_transaction_to_financial_journal();

CREATE OR REPLACE FUNCTION public.post_seller_payout_journal_event(
  p_transaction_id uuid,
  p_payout_reference text,
  p_amount bigint,
  p_status text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_tx public.transactions%ROWTYPE;
  v_payable_account uuid;
  v_clearing_account uuid;
  v_lines jsonb;
  v_event text := lower(COALESCE(p_status,''));
  v_key text;
BEGIN
  IF p_transaction_id IS NULL OR p_payout_reference IS NULL
     OR length(trim(p_payout_reference)) = 0 OR p_amount IS NULL OR p_amount <= 0
     OR v_event NOT IN ('success','reversed') THEN
    RAISE EXCEPTION 'Invalid seller payout journal event';
  END IF;

  SELECT * INTO v_tx FROM public.transactions
   WHERE id = p_transaction_id FOR SHARE;
  IF NOT FOUND OR v_tx.payment_verified IS DISTINCT FROM true
     OR v_tx.status NOT IN ('released','completed')
     OR COALESCE(v_tx.payment_method,'paystack') = 'campus_wallet'
     OR v_tx.amount IS DISTINCT FROM p_amount THEN
    RAISE EXCEPTION 'Seller payout journal event does not match a released Paystack transaction';
  END IF;
  IF v_tx.refund_status = 'processed' THEN
    RAISE EXCEPTION 'A refunded transaction cannot be paid out';
  END IF;

  v_payable_account := public.get_financial_account_id(
    'liability.seller_payable','liability','credit',v_tx.seller_id,
    'Seller payout payable for user ' || v_tx.seller_id::text
  );
  v_clearing_account := public.get_financial_account_id(
    'asset.paystack_clearing','asset','debit',NULL,'Paystack merchant clearing control'
  );

  IF v_event = 'success' THEN
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id',v_payable_account,'debit',p_amount,'credit',0),
      jsonb_build_object('account_id',v_clearing_account,'debit',0,'credit',p_amount)
    );
  ELSE
    v_key := 'paystack-payout:' || trim(p_payout_reference) || ':success';
    IF NOT EXISTS (
      SELECT 1 FROM public.financial_journal_transactions WHERE idempotency_key = v_key
    ) THEN
      RAISE EXCEPTION 'Payout reversal has no original successful payout journal';
    END IF;
    v_lines := jsonb_build_array(
      jsonb_build_object('account_id',v_clearing_account,'debit',p_amount,'credit',0),
      jsonb_build_object('account_id',v_payable_account,'debit',0,'credit',p_amount)
    );
  END IF;

  v_key := 'paystack-payout:' || trim(p_payout_reference) || ':' || v_event;
  RETURN public.post_financial_journal_transaction(
    'paystack.payout.' || v_event,
    'seller_payout_transfers',
    'payout_reference',
    p_transaction_id,
    v_key,
    v_lines,
    jsonb_build_object(
      'transaction_id',p_transaction_id,
      'seller_id',v_tx.seller_id,
      'payout_reference',trim(p_payout_reference),
      'provider_status',v_event
    )
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.post_seller_payout_journal_event(uuid,text,bigint,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_seller_payout_journal_event(uuid,text,bigint,text)
  TO service_role;

-- Backfill the compatibility wallet journal, verified Paystack escrow funding,
-- and any already-released/refunded transactions. Deterministic event keys make
-- this migration safe to re-run after a partial deployment.
DO $backfill$
DECLARE
  v_entry public.financial_ledger%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
  v_payout record;
BEGIN
  FOR v_entry IN
    SELECT * FROM public.financial_ledger
     WHERE source = 'plug_credit_ledger'
     ORDER BY created_at, id
  LOOP
    PERFORM public.post_wallet_financial_journal_entry(v_entry);
  END LOOP;

  FOR v_tx IN
    SELECT * FROM public.transactions
     WHERE payment_verified IS TRUE
       AND COALESCE(payment_method,'paystack') <> 'campus_wallet'
     ORDER BY created_at, id
  LOOP
    PERFORM public.post_paystack_transaction_journal_event(v_tx,'funded');
    IF v_tx.status IN ('released','completed') THEN
      PERFORM public.post_paystack_transaction_journal_event(v_tx,'released');
    END IF;
    IF v_tx.refund_status = 'processed' THEN
      PERFORM public.post_paystack_transaction_journal_event(v_tx,'refunded');
    END IF;
  END LOOP;

  -- PR #103 is intentionally still a separate, unmerged dependency. If its
  -- payout table is present when this migration runs, recover conclusive
  -- provider outcomes. A later payout integration migration also installs
  -- the trigger for future status changes.
  IF to_regclass('public.seller_payout_transfers') IS NOT NULL THEN
    FOR v_payout IN
      SELECT p.transaction_id,p.reference,p.amount_kobo,p.status
        FROM public.seller_payout_transfers p
       WHERE p.status IN ('success','reversed')
       ORDER BY p.created_at,p.id
    LOOP
      PERFORM public.post_seller_payout_journal_event(
        v_payout.transaction_id,v_payout.reference,v_payout.amount_kobo,'success'
      );
      IF v_payout.status = 'reversed' THEN
        PERFORM public.post_seller_payout_journal_event(
          v_payout.transaction_id,v_payout.reference,v_payout.amount_kobo,'reversed'
        );
      END IF;
    END LOOP;
  END IF;
END;
$backfill$;

COMMENT ON TABLE public.financial_accounts IS
  'Chart of accounts for Campus Plug double-entry accounting. NGN balances are derived from immutable journal entries.';
COMMENT ON TABLE public.financial_journal_transactions IS
  'Immutable, idempotent, balanced accounting events. Amounts are integer kobo.';
COMMENT ON TABLE public.financial_journal_entries IS
  'Immutable debit/credit lines. Each journal transaction is balanced before posting.';
