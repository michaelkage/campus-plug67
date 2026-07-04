-- ============================================================
-- Campus Plug v6.8.0 Migration (CP-67 MATRIX)
-- Phase 2 & 3: Overhaul Schema
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 1. SKU PREDEFINED MATRIX CORE ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.global_sku_catalog (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    category_id INT,
    baseline_lifespan INTERVAL,
    lower_price_bound NUMERIC,
    upper_price_bound NUMERIC,
    verified_metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS global_sku_title_trgm_idx 
ON public.global_sku_catalog USING GIN (title gin_trgm_ops);

ALTER TABLE public.listings 
ADD COLUMN IF NOT EXISTS global_sku_id UUID REFERENCES public.global_sku_catalog(id) ON DELETE SET NULL;

-- ── 2. THE BEACON: DEMAND GENERATION ARCHITECTURE ─────────────

CREATE TABLE IF NOT EXISTS public.buyer_broadcast_demands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    buyer_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    category_id INT,
    max_budget NUMERIC,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Trigger to notify sellers of active buyer intent
CREATE OR REPLACE FUNCTION public.notify_sellers_of_demand()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    -- Insert notifications for sellers who have listings in the same category
    INSERT INTO public.notifications (user_id, type, title, body, data)
    SELECT DISTINCT l.seller_id, 'buyer_demand_alert', 
           'New Buyer Demand: ' || NEW.title,
           'A buyer is looking for an item matching your inventory! Budget: ₦' || (NEW.max_budget / 100)::text,
           jsonb_build_object('demand_id', NEW.id, 'category_id', NEW.category_id)
    FROM public.listings l
    WHERE l.category_id = NEW.category_id
      AND l.status IN ('active', 'sold');
      
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_buyer_demand_notify ON public.buyer_broadcast_demands;
CREATE TRIGGER trg_buyer_demand_notify
    AFTER INSERT ON public.buyer_broadcast_demands
    FOR EACH ROW EXECUTE PROCEDURE public.notify_sellers_of_demand();

-- ── 3. PLUGHUB 7-STATE ESCROW & CUSTODY ENGINE ────────────────

-- Check if the enum already exists (to avoid duplicate type error)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'escrow_state') THEN
        CREATE TYPE public.escrow_state AS ENUM (
            'payment_pending', 
            'funds_escrowed', 
            'locker_deposited', 
            'received_by_borrower', 
            'return_deposited', 
            'returned_to_owner', 
            'funds_released_or_disputed'
        );
    END IF;
END$$;

CREATE TABLE IF NOT EXISTS public.gear_rentals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID REFERENCES public.listings(id),
    borrower_id UUID REFERENCES public.profiles(id),
    lender_id UUID REFERENCES public.profiles(id),
    current_state public.escrow_state DEFAULT 'payment_pending',
    logistics_meta JSONB DEFAULT '{"locker_id": null, "pickup_token_hash": null, "dropoff_token_hash": null, "verification_timestamp": null}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.escrow_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id UUID REFERENCES public.transactions(id),
    current_state public.escrow_state DEFAULT 'payment_pending',
    logistics_meta JSONB DEFAULT '{"locker_id": null, "pickup_token_hash": null, "dropoff_token_hash": null, "verification_timestamp": null}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Ensure logistics_meta exists if table was already there
DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'escrow_transactions') THEN
        ALTER TABLE public.escrow_transactions 
        ADD COLUMN IF NOT EXISTS logistics_meta JSONB DEFAULT '{"locker_id": null, "pickup_token_hash": null, "dropoff_token_hash": null, "verification_timestamp": null}'::jsonb;
        
        ALTER TABLE public.escrow_transactions 
        ADD COLUMN IF NOT EXISTS current_state public.escrow_state DEFAULT 'payment_pending';
    END IF;
END $$;


-- ── 4. REFERRAL LOOPS & ACADEMIC ENGINE ───────────────────────

CREATE TABLE IF NOT EXISTS public.wallets (
    user_id UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    balance NUMERIC DEFAULT 0 -- storing in Kobo (100.00 NGN = 10000)
);

CREATE TABLE IF NOT EXISTS public.referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referrer_id UUID REFERENCES public.profiles(id),
    referred_id UUID REFERENCES public.profiles(id),
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.process_referral_reward()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.campus_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    university TEXT NOT NULL,
    coordinates JSONB
);

CREATE TABLE IF NOT EXISTS public.class_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_code TEXT NOT NULL,
    venue_id UUID REFERENCES public.campus_locations(id),
    materials_needed JSONB DEFAULT '[]'::jsonb,
    alert_time TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS public.academic_resources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    course_code TEXT NOT NULL,
    title TEXT NOT NULL,
    file_url TEXT,
    uploader_id UUID REFERENCES public.profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ 
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'group_chats') THEN
        ALTER TABLE public.group_chats 
        ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS exam_archive_date TIMESTAMPTZ;
    END IF;
END $$;


-- ── 5. BACKEND EDGE SERVICES (RPC) ────────────────────────────

-- Option A Logic: match_global_sku
CREATE OR REPLACE FUNCTION public.match_global_sku(search_title TEXT)
RETURNS TABLE (
    id UUID,
    title TEXT,
    category_id INT,
    baseline_lifespan INTERVAL,
    lower_price_bound NUMERIC,
    upper_price_bound NUMERIC,
    verified_metadata JSONB,
    similarity REAL
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    RETURN QUERY
    SELECT 
        g.id,
        g.title,
        g.category_id,
        g.baseline_lifespan,
        g.lower_price_bound,
        g.upper_price_bound,
        g.verified_metadata,
        similarity(g.title, search_title) AS similarity
    FROM public.global_sku_catalog g
    WHERE similarity(g.title, search_title) > 0.4
    ORDER BY similarity DESC
    LIMIT 4;
END;
$$;

-- ── 6. ANTI-GHOSTING CRON ROUTINES ────────────────────────────

CREATE OR REPLACE FUNCTION public.cron_inject_ghost_polls()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.messages (sender_id, listing_id, content, is_system_msg)
    SELECT NULL, l.id, '{"type": "poll", "question": "Still interested in this deal?"}'::text, true
    FROM public.listings l
    WHERE l.status = 'active';
END;
$$;

CREATE OR REPLACE FUNCTION public.cron_pin_beacon_demands()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.cron_lock_old_study_repos()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'group_chats') THEN
        EXECUTE 'UPDATE public.group_chats SET is_archived = TRUE WHERE exam_archive_date < NOW() AND is_archived = FALSE;';
    END IF;
END;
$$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule('inject_ghost_polls', '0 */12 * * *', 'SELECT public.cron_inject_ghost_polls()');
        PERFORM cron.schedule('pin_beacon_demands', '0 */12 * * *', 'SELECT public.cron_pin_beacon_demands()');
        PERFORM cron.schedule('lock_old_study_repos', '0 */12 * * *', 'SELECT public.cron_lock_old_study_repos()');
    END IF;
EXCEPTION WHEN OTHERS THEN
END $$;
