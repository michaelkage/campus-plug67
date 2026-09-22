-- Campus Plug — marketplace RLS hardening
-- Tighten core marketplace writes and remove broad transaction reads.

-- Listings: only the authenticated owner may create/update/delete their own
-- listing, and the listing must stay attached to the seller's resolved campus.
DROP POLICY IF EXISTS "Allow authenticated users to insert listings" ON public.listings;
DROP POLICY IF EXISTS "Auth users create listings" ON public.listings;
DROP POLICY IF EXISTS "Sellers update own listings" ON public.listings;
DROP POLICY IF EXISTS "Sellers delete own listings" ON public.listings;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.listings;

CREATE POLICY "Authenticated users create own listings"
  ON public.listings
  FOR INSERT
  TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = seller_id
    AND university = (
      SELECT p.university
      FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Sellers update own listings"
  ON public.listings
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = seller_id)
  WITH CHECK (
    (SELECT auth.uid()) = seller_id
    AND university = (
      SELECT p.university
      FROM public.profiles p
      WHERE p.id = (SELECT auth.uid())
    )
  );

CREATE POLICY "Sellers delete own listings"
  ON public.listings
  FOR DELETE
  TO authenticated
  USING ((SELECT auth.uid()) = seller_id);

-- Profiles: remove the duplicate insert policy and keep the authenticated
-- self-service rule. The auth trigger remains the authoritative creator.
DROP POLICY IF EXISTS "Allow users to insert their own profile" ON public.profiles;
DROP POLICY IF EXISTS "Users insert own profile" ON public.profiles;

CREATE POLICY "Users insert own profile"
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = id);

-- Transactions contain payment/escrow metadata. Anonymous and unrelated
-- authenticated users must not be able to enumerate them.
DROP POLICY IF EXISTS "Allow public read on transactions" ON public.transactions;

-- Activity feed: keep public reads, but do not grant authenticated users
-- unrestricted UPDATE/DELETE/INSERT access. Listing creation may still emit
-- a feed event when the actor matches the current user.
DROP POLICY IF EXISTS "Allow authenticated read/write on activity_feed" ON public.activity_feed;
DROP POLICY IF EXISTS "Allow public read on activity_feed" ON public.activity_feed;

CREATE POLICY "Authenticated users insert own activity"
  ON public.activity_feed
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = actor_id);
