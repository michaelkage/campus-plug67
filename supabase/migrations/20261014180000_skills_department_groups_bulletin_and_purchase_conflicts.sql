-- Campus Plug: skill listing improvements, department-scoped groups, bulletin, and idempotent purchase guards.

-- Skills: keep starting_price as the minimum so existing booking code remains compatible.
ALTER TABLE public.gigs ADD COLUMN IF NOT EXISTS max_price bigint;
ALTER TABLE public.gigs ADD COLUMN IF NOT EXISTS available_days text[] NOT NULL DEFAULT '{}';
ALTER TABLE public.gigs DROP CONSTRAINT IF EXISTS gigs_max_price_check;
ALTER TABLE public.gigs ADD CONSTRAINT gigs_max_price_check
  CHECK (max_price IS NULL OR max_price >= starting_price);

DROP POLICY IF EXISTS "Sellers delete own gigs" ON public.gigs;
CREATE POLICY "Sellers delete own gigs" ON public.gigs
  FOR DELETE TO authenticated USING (seller_id = (SELECT auth.uid()));

-- Study groups: a group is visible only to students in its department at that university.
ALTER TABLE public.group_chats ADD COLUMN IF NOT EXISTS department text;
UPDATE public.group_chats gc
SET department = COALESCE(NULLIF(trim(p.department), ''), 'General')
FROM public.profiles p
WHERE p.id = gc.creator_id AND gc.department IS NULL;
UPDATE public.group_chats SET department = 'General' WHERE department IS NULL;
ALTER TABLE public.group_chats ALTER COLUMN department SET DEFAULT 'General';
CREATE INDEX IF NOT EXISTS group_chats_department_idx
  ON public.group_chats(university, department, is_archived, last_activity_at DESC);

DROP POLICY IF EXISTS "Group chats visible to university" ON public.group_chats;
CREATE POLICY "Group chats visible to matching department"
  ON public.group_chats FOR SELECT TO authenticated
  USING (
    university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    AND department = COALESCE(
      (SELECT NULLIF(trim(p.department), '') FROM public.profiles p WHERE p.id = (SELECT auth.uid())),
      'General'
    )
  );

DROP POLICY IF EXISTS "Users create group chats" ON public.group_chats;
CREATE POLICY "Users create department group chats"
  ON public.group_chats FOR INSERT TO authenticated
  WITH CHECK (
    creator_id = (SELECT auth.uid())
    AND university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    AND department = COALESCE(
      (SELECT NULLIF(trim(p.department), '') FROM public.profiles p WHERE p.id = (SELECT auth.uid())),
      'General'
    )
  );

-- Child-table policies must enforce the same university + department boundary as group_chats.
-- UI filtering is not authorization: clients can submit arbitrary group IDs directly.
DROP POLICY IF EXISTS "Users join own campus groups" ON public.group_chat_members;
DROP POLICY IF EXISTS "Users join groups" ON public.group_chat_members;
CREATE POLICY "Users join matching department groups"
  ON public.group_chat_members FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.group_chats g
      JOIN public.profiles p ON p.id = (SELECT auth.uid())
      WHERE g.id = group_chat_members.group_id
        AND g.university = p.university
        AND g.department = COALESCE(NULLIF(trim(p.department), ''), 'General')
        AND (
          role = 'member'
          OR (role = 'owner' AND g.creator_id = (SELECT auth.uid()))
        )
    )
  );

DROP POLICY IF EXISTS "Members read group messages" ON public.group_chat_messages;
CREATE POLICY "Members read matching department messages"
  ON public.group_chat_messages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.group_chats g
      JOIN public.profiles p ON p.id = (SELECT auth.uid())
      JOIN public.group_chat_members m
        ON m.group_id = g.id AND m.user_id = (SELECT auth.uid())
      WHERE g.id = group_chat_messages.group_id
        AND g.university = p.university
        AND g.department = COALESCE(NULLIF(trim(p.department), ''), 'General')
    )
  );

DROP POLICY IF EXISTS "Members send group messages" ON public.group_chat_messages;
CREATE POLICY "Members send matching department messages"
  ON public.group_chat_messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1
      FROM public.group_chats g
      JOIN public.profiles p ON p.id = (SELECT auth.uid())
      JOIN public.group_chat_members m
        ON m.group_id = g.id AND m.user_id = (SELECT auth.uid())
      WHERE g.id = group_chat_messages.group_id
        AND g.university = p.university
        AND g.department = COALESCE(NULLIF(trim(p.department), ''), 'General')
    )
  );

-- News bulletin: campus-specific posts, with publishing restricted to trusted campus moderators.
CREATE TABLE IF NOT EXISTS public.campus_bulletins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  university text NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 160),
  body text NOT NULL CHECK (length(trim(body)) BETWEEN 3 AND 10000),
  category text NOT NULL DEFAULT 'Announcement'
    CHECK (category IN ('Announcement','Academic','Events','Deadline','Safety','Other')),
  is_pinned boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campus_bulletins_feed_idx
  ON public.campus_bulletins(university, is_pinned DESC, created_at DESC);
ALTER TABLE public.campus_bulletins ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.campus_bulletins TO authenticated;

DROP POLICY IF EXISTS "Campus users read bulletins" ON public.campus_bulletins;
CREATE POLICY "Campus users read bulletins" ON public.campus_bulletins
  FOR SELECT TO authenticated
  USING (university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid())));
DROP POLICY IF EXISTS "Trusted campus moderators publish bulletins" ON public.campus_bulletins;
CREATE POLICY "Trusted campus moderators publish bulletins" ON public.campus_bulletins
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND (COALESCE(p.badges, ARRAY[]::text[]) @> ARRAY['Plug Dev']
          OR COALESCE(p.badges, ARRAY[]::text[]) @> ARRAY['Community Hero'])
    )
  );
DROP POLICY IF EXISTS "Bulletin authors update own posts" ON public.campus_bulletins;
CREATE POLICY "Bulletin authors update own posts" ON public.campus_bulletins
  FOR UPDATE TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    AND university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
  )
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
        AND (COALESCE(p.badges, ARRAY[]::text[]) @> ARRAY['Plug Dev']
          OR COALESCE(p.badges, ARRAY[]::text[]) @> ARRAY['Community Hero'])
    )
  );
DROP POLICY IF EXISTS "Bulletin authors delete own posts" ON public.campus_bulletins;
CREATE POLICY "Bulletin authors delete own posts" ON public.campus_bulletins
  FOR DELETE TO authenticated USING (created_by = (SELECT auth.uid()));

-- Avoid surfacing a raw 23505 when another active transaction already exists.
-- Return a stable conflict payload before any wallet debit or Paystack init.
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

  SELECT * INTO v_tx FROM public.transactions
  WHERE listing_id = p_listing_id
    AND status IN ('pending','locked','meetup_initiated','release_requested','disputed')
  ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('success',false,'code','active_transaction_exists',
      'message','This listing already has an active purchase. Refresh the listing or open your transactions.',
      'transaction_id',v_tx.id,'status',v_tx.status);
  END IF;

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
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success',false,'code','active_transaction_exists',
    'message','This listing already has an active purchase. Refresh the listing and check your transactions.');
END; $$;

CREATE OR REPLACE FUNCTION public.create_pending_paystack_transaction(p_listing_id uuid, p_paystack_ref text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_buyer uuid := auth.uid();
  v_listing public.listings%ROWTYPE;
  v_tx public.transactions%ROWTYPE;
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

  SELECT * INTO v_tx FROM public.transactions
  WHERE listing_id=p_listing_id
    AND status IN ('pending','locked','meetup_initiated','release_requested','disputed')
  ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('success',false,'code','active_transaction_exists',
      'message','This listing already has an active purchase. Refresh the listing or open your transactions.',
      'id',v_tx.id,'listing_id',v_tx.listing_id,'status',v_tx.status);
  END IF;

  INSERT INTO public.transactions(listing_id,buyer_id,seller_id,amount,status,paystack_ref)
  VALUES(v_listing.id,v_buyer,v_listing.seller_id,v_listing.price,'pending',p_paystack_ref)
  RETURNING * INTO v_tx;
  RETURN jsonb_build_object('success',true,'id',v_tx.id,'listing_id',v_tx.listing_id,
    'buyer_id',v_tx.buyer_id,'seller_id',v_tx.seller_id,'amount',v_tx.amount,
    'status',v_tx.status,'paystack_ref',v_tx.paystack_ref);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('success',false,'code','active_transaction_exists',
    'message','This listing already has an active purchase. Refresh the listing and check your transactions.');
END; $$;

REVOKE ALL ON FUNCTION public.create_wallet_micro_escrow(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_wallet_micro_escrow(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.create_pending_paystack_transaction(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_pending_paystack_transaction(uuid,text) TO authenticated;
