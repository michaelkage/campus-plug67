-- Keep seller earnings and payout messaging aligned with the actual payment rail.
-- Escrow resolution is not a Paystack transfer. Campus Wallet proceeds are
-- credited atomically to PlugCredit; Paystack proceeds count as earnings only
-- after a transfer-success event has been authoritatively recorded.

CREATE OR REPLACE FUNCTION public.handle_transaction_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $function$
DECLARE
  actor_name text;
  item_title text;
  auto_ts timestamptz;
  wallet_settlement boolean;
BEGIN
  wallet_settlement := COALESCE(NEW.payment_method, 'paystack') = 'campus_wallet';

  IF NEW.status = 'locked' AND OLD.status = 'pending' THEN
    UPDATE public.listings SET status = 'reserved' WHERE id = NEW.listing_id;

    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES (NEW.seller_id, 'payment_locked',
      '🔐 Payment Locked in Escrow',
      'Buyer paid! Arrange your Safe-Exchange meetup.',
      jsonb_build_object('transaction_id', NEW.id));
  END IF;

  IF NEW.status = 'meetup_initiated' AND OLD.status = 'locked' THEN
    INSERT INTO public.scheduled_jobs(type, entity_id, run_at)
    VALUES ('check_qr_timeout', NEW.id, NEW.meetup_initiated_at + interval '24 hours');

    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES
      (NEW.buyer_id, 'meetup_initiated', '📍 Meetup Confirmed',
        'You have 24 hours to scan the seller''s QR code.',
        jsonb_build_object('transaction_id', NEW.id)),
      (NEW.seller_id, 'meetup_initiated', '📍 Buyer is On Their Way',
        'Show your QR code. Buyer has 24 hours to scan.',
        jsonb_build_object('transaction_id', NEW.id));
  END IF;

  IF NEW.status = 'release_requested' AND OLD.status IN ('locked', 'meetup_initiated') THEN
    auto_ts := now() + interval '48 hours';
    NEW.auto_release_at := auto_ts;

    INSERT INTO public.scheduled_jobs(type, entity_id, run_at)
    VALUES ('auto_release', NEW.id, auto_ts);

    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES
      (NEW.buyer_id, 'release_requested', '⚠️ Seller Requested Fund Release',
        'You have 48 hours to dispute or funds auto-release to seller.',
        jsonb_build_object('transaction_id', NEW.id, 'auto_release_at', auto_ts)),
      (NEW.seller_id, 'release_requested', '⏳ Release Requested',
        'Buyer notified. Funds auto-release in 48 hours if no dispute.',
        jsonb_build_object('transaction_id', NEW.id));
  END IF;

  IF NEW.status = 'disputed' AND OLD.status <> 'disputed' THEN
    UPDATE public.scheduled_jobs SET executed = true, executed_at = now()
    WHERE entity_id = NEW.id AND type = 'auto_release' AND NOT executed;

    INSERT INTO public.notifications(user_id, type, title, body, data)
    VALUES
      (NEW.seller_id, 'disputed', '🚨 Buyer Raised a Dispute',
        'Your transaction is under review. Campus Plug will mediate.',
        jsonb_build_object('transaction_id', NEW.id)),
      (NEW.buyer_id, 'disputed', '🚨 Dispute Filed',
        'Your dispute is being reviewed. We''ll update you within 24 hours.',
        jsonb_build_object('transaction_id', NEW.id));
  END IF;

  IF NEW.status = 'released' AND OLD.status <> 'released' THEN
    SELECT full_name INTO actor_name FROM public.profiles WHERE id = NEW.seller_id;
    SELECT title INTO item_title FROM public.listings WHERE id = NEW.listing_id;

    UPDATE public.listings SET status = 'sold' WHERE id = NEW.listing_id;

    -- Count the sale immediately, but only count money as earned when it has
    -- actually reached the seller's Campus Wallet or confirmed bank payout.
    UPDATE public.profiles
    SET plug_score = plug_score + 50,
        total_sales = total_sales + 1,
        total_earnings = total_earnings + CASE WHEN wallet_settlement THEN NEW.amount ELSE 0 END
    WHERE id = NEW.seller_id;

    WITH seller AS (
      SELECT total_sales, plug_score FROM public.profiles WHERE id = NEW.seller_id
    )
    UPDATE public.profiles
    SET badges = (
      SELECT array_agg(DISTINCT b) FILTER (WHERE b IS NOT NULL)
      FROM (
        SELECT unnest(badges) AS b
        UNION ALL
        SELECT CASE
          WHEN (SELECT total_sales FROM seller) >= 100 THEN 'Hall of Fame'
          WHEN (SELECT total_sales FROM seller) >= 50 THEN 'Top Seller'
          WHEN (SELECT total_sales FROM seller) >= 10 THEN 'Rising Star'
          ELSE NULL
        END
      ) sub
    )
    WHERE id = NEW.seller_id;

    INSERT INTO public.activity_feed(actor_name, actor_id, action, subject, amount, emoji, university)
    SELECT actor_name, NEW.seller_id, 'completed a sale', item_title, NEW.amount, '💰', l.university
    FROM public.listings l WHERE l.id = NEW.listing_id;

    IF wallet_settlement THEN
      INSERT INTO public.notifications(user_id, type, title, body, data)
      VALUES
        (NEW.buyer_id, 'transaction_complete', '✅ Exchange Complete!',
          'The exchange is complete and the seller has received PlugCredit.',
          jsonb_build_object('transaction_id', NEW.id)),
        (NEW.seller_id, 'funds_released', '💰 Campus Wallet Credited',
          '₦' || (NEW.amount / 100) || ' has been credited to your Campus Wallet.',
          jsonb_build_object('transaction_id', NEW.id, 'payout_status', 'paid'));
    ELSE
      INSERT INTO public.notifications(user_id, type, title, body, data)
      VALUES
        (NEW.buyer_id, 'transaction_complete', '✅ Exchange Complete!',
          'The exchange is complete. Seller bank payout is handled separately after escrow resolution.',
          jsonb_build_object('transaction_id', NEW.id)),
        (NEW.seller_id, 'funds_released', '⏳ Escrow Resolved · Payout Pending',
          'Your exchange is complete, but your bank payout has not yet been confirmed. Check your payout status before treating this sale as paid.',
          jsonb_build_object('transaction_id', NEW.id, 'payout_status', 'approved_for_settlement'));
    END IF;

    UPDATE public.scheduled_jobs SET executed = true, executed_at = now()
    WHERE entity_id = NEW.id AND NOT executed;
  END IF;

  RETURN NEW;
END;
$function$;


-- A Paystack transfer-success recorder changes payout_status to paid. Credit
-- the denormalized earnings total exactly once at that authoritative boundary.
CREATE OR REPLACE FUNCTION public.credit_seller_earnings_after_external_payout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NEW.payout_status = 'paid'
     AND OLD.payout_status IS DISTINCT FROM 'paid'
     AND COALESCE(NEW.payment_method, 'paystack') <> 'campus_wallet' THEN
    IF NEW.status NOT IN ('released', 'completed')
       OR NEW.payment_verified IS DISTINCT FROM true
       OR NEW.amount IS NULL
       OR NEW.amount <= 0 THEN
      RAISE EXCEPTION 'External seller payout cannot be recorded before verified escrow resolution';
    END IF;

    UPDATE public.profiles
       SET total_earnings = COALESCE(total_earnings, 0) + NEW.amount
     WHERE id = NEW.seller_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Seller profile not found while recording confirmed payout';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_credit_seller_earnings_after_external_payout ON public.transactions;
CREATE TRIGGER trg_credit_seller_earnings_after_external_payout
AFTER UPDATE OF payout_status ON public.transactions
FOR EACH ROW
WHEN (
  OLD.payout_status IS DISTINCT FROM 'paid'
  AND NEW.payout_status = 'paid'
  AND COALESCE(NEW.payment_method, 'paystack') <> 'campus_wallet'
)
EXECUTE FUNCTION public.credit_seller_earnings_after_external_payout();

-- Public profile earnings are a financial figure, not gross escrow volume.
-- Keep completed sales visible while excluding Paystack escrow until the
-- corresponding seller transfer has actually succeeded.
CREATE OR REPLACE FUNCTION private.get_public_profile_stats(p_profile_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  WITH tx_stats AS (
    SELECT
      t.seller_id,
      count(*) FILTER (
        WHERE t.status = 'released'::text OR t.status = 'completed'::text
      ) AS total_sales,
      COALESCE(
        sum(t.amount) FILTER (
          WHERE (t.status = 'released'::text OR t.status = 'completed'::text)
            AND (
              COALESCE(t.payment_method, 'paystack') = 'campus_wallet'
              OR t.payout_status = 'paid'
            )
        ),
        0::numeric
      ) AS total_earnings
    FROM public.transactions AS t
    WHERE t.seller_id = p_profile_id
    GROUP BY t.seller_id
  )
  SELECT pg_catalog.to_jsonb(stats)
  FROM (
    SELECT
      p.id,
      p.full_name,
      p.university,
      p.department,
      p.level,
      p.plug_score,
      COALESCE(tx_stats.total_sales, 0::bigint) AS total_sales,
      COALESCE(tx_stats.total_earnings, 0::numeric) AS total_earnings,
      p.badges,
      p.is_verified,
      p.created_at,
      COALESCE(rating_stats.avg_rating, 0::numeric) AS avg_rating,
      COALESCE(rating_stats.rating_count, 0::bigint) AS rating_count,
      (
        SELECT count(*) FROM public.listings AS listing
        WHERE listing.seller_id = p.id AND listing.status = 'active'
      ) AS active_listings,
      (
        SELECT count(*)
        FROM public.listing_exif_flags AS exif
        JOIN public.listings AS listing ON listing.id = exif.listing_id
        WHERE listing.seller_id = p.id
          AND NOT exif.gps_mismatch
          AND NOT exif.timestamp_flag
      ) AS verified_uploads
    FROM public.profiles AS p
    LEFT JOIN tx_stats ON p.id = tx_stats.seller_id
    LEFT JOIN public.profile_ratings AS rating_stats ON p.id = rating_stats.profile_id
    WHERE p.id = p_profile_id
  ) AS stats;
$function$;

REVOKE ALL ON FUNCTION private.get_public_profile_stats(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.get_public_profile_stats(uuid) TO anon, authenticated;

DO $assertions$
DECLARE
  v_trigger text := pg_get_functiondef('public.handle_transaction_update()'::regprocedure);
  v_stats text := pg_get_functiondef('private.get_public_profile_stats(uuid)'::regprocedure);
  v_earnings_trigger text := pg_get_functiondef('public.credit_seller_earnings_after_external_payout()'::regprocedure);
BEGIN
  IF position('CASE WHEN wallet_settlement THEN NEW.amount ELSE 0 END' IN v_trigger) = 0 THEN
    RAISE EXCEPTION 'External escrow release must not increment seller earnings before payout';
  END IF;
  IF position('bank payout has not yet been confirmed' IN v_trigger) = 0 THEN
    RAISE EXCEPTION 'Paystack seller notification must not claim payout completion';
  END IF;
  IF position('t.payout_status = ''paid''' IN v_stats) = 0
     OR position('t.payment_method' IN v_stats) = 0 THEN
    RAISE EXCEPTION 'Public profile earnings must include only wallet credits or confirmed external payouts';
  END IF;
  IF position('OLD.payout_status IS DISTINCT FROM ''paid''' IN v_earnings_trigger) = 0
     OR position('NEW.payment_verified IS DISTINCT FROM true' IN v_earnings_trigger) = 0
     OR position('COALESCE(NEW.payment_method, ''paystack'') <> ''campus_wallet''' IN v_earnings_trigger) = 0 THEN
    RAISE EXCEPTION 'External seller earnings must be credited once, only after verified Paystack payout';
  END IF;
END;
$assertions$;
