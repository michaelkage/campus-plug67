-- Campus Plug Phase 2: database integrity + RLS hardening.
-- Forward-only migration. Existing application flows are preserved where safe,
-- while client-controlled authority fields are removed from direct writes.

-- ---------------------------------------------------------------------------
-- Transactions: buyers may create only a new pending transaction for the exact
-- listing price/seller. Payment and escrow state remain server-authoritative.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Buyers create transactions" ON public.transactions;
CREATE POLICY "Buyers create pending transactions"
  ON public.transactions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = buyer_id
    AND status = 'pending'
    AND payment_verified = false
    AND seller_id = (SELECT l.seller_id FROM public.listings l WHERE l.id = listing_id)
    AND amount = (SELECT l.price FROM public.listings l WHERE l.id = listing_id)
  );

-- Buyers/sellers may not use the generic UPDATE path to rewrite escrow,
-- payment, ownership, or accounting fields. Server functions use service_role.
DROP POLICY IF EXISTS "Parties update own transactions" ON public.transactions;
CREATE POLICY "Parties update transaction metadata only"
  ON public.transactions
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = buyer_id OR auth.uid() = seller_id)
  WITH CHECK (
    (auth.uid() = buyer_id OR auth.uid() = seller_id)
    AND buyer_id = (SELECT t.buyer_id FROM public.transactions t WHERE t.id = id)
    AND seller_id = (SELECT t.seller_id FROM public.transactions t WHERE t.id = id)
    AND listing_id = (SELECT t.listing_id FROM public.transactions t WHERE t.id = id)
    AND amount = (SELECT t.amount FROM public.transactions t WHERE t.id = id)
    AND payment_verified = (SELECT t.payment_verified FROM public.transactions t WHERE t.id = id)
    AND paystack_ref = (SELECT t.paystack_ref FROM public.transactions t WHERE t.id = id)
  );

-- ---------------------------------------------------------------------------
-- Lost & Found: reporter identity must match the authenticated actor.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Auth users report items" ON public.lost_found;
CREATE POLICY "Users report items as themselves"
  ON public.lost_found
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = reporter_id);

-- ---------------------------------------------------------------------------
-- Activity feed is a server-generated surface. The original policy used
-- WITH CHECK(true), which made it writable by any authenticated client.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Service role inserts activity" ON public.activity_feed;
CREATE POLICY "Service role inserts activity"
  ON public.activity_feed
  FOR INSERT
  TO service_role
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Passkeys: credential material is never publicly readable and cannot be
-- registered/rewritten directly from the browser. The Edge Function owns
-- registration and verification with the service role.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Users manage own passkeys" ON public.passkey_credentials;
DROP POLICY IF EXISTS "Passkey public read by credential_id" ON public.passkey_credentials;
CREATE POLICY "Users read own passkeys"
  ON public.passkey_credentials
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
CREATE POLICY "Users remove own passkeys"
  ON public.passkey_credentials
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Explicit RLS posture for security tables: no browser access to device-ban
-- or security-registration state. Existing service-role policies remain valid.
-- ---------------------------------------------------------------------------
ALTER TABLE public.banned_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_security ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can read banned devices" ON public.banned_devices;
DROP POLICY IF EXISTS "Users read own security records" ON public.user_security;
DROP POLICY IF EXISTS "Users manage own security records" ON public.user_security;

COMMENT ON POLICY "Buyers create pending transactions" ON public.transactions
  IS 'Client can only initiate a transaction at the canonical listing price and seller; payment/escrow state is server-authoritative.';
COMMENT ON POLICY "Users read own passkeys" ON public.passkey_credentials
  IS 'Credential public keys and metadata are private to the owning account; ceremony writes occur through the Edge Function.';
