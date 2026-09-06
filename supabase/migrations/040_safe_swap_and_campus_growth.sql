-- Campus Plug v6.12: Safe Swap Zone enforcement + campus growth primitives.
-- Append-only. Preserves the v6.10 escrow state machine while adding a server-side
-- 50m UNILAG safe-zone gate for buyer QR release.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Safe Swap Zone policy
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.safe_zones
  ADD COLUMN IF NOT EXISTS zone_type text NOT NULL DEFAULT 'verified_meetup';

-- The product contract for UNILAG is a strict 50m release radius.
UPDATE public.safe_zones
SET radius_m = 50
WHERE university = 'University of Lagos';

CREATE OR REPLACE FUNCTION public.is_in_safe_swap_zone(
  p_lat numeric,
  p_lng numeric,
  p_university text
)
RETURNS TABLE(zone_id uuid, zone_name text, distance_m numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT z.id, z.name, public.gps_distance_m(p_lat,p_lng,z.lat,z.lng)
  FROM public.safe_zones z
  WHERE z.active = true
    AND z.university = p_university
    AND public.gps_distance_m(p_lat,p_lng,z.lat,z.lng) <= 50
  ORDER BY public.gps_distance_m(p_lat,p_lng,z.lat,z.lng)
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.is_in_safe_swap_zone(numeric,numeric,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.is_in_safe_swap_zone(numeric,numeric,text) TO authenticated,service_role;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS buyer_location_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS seller_location_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS buyer_safe_zone_id uuid REFERENCES public.safe_zones(id),
  ADD COLUMN IF NOT EXISTS seller_safe_zone_id uuid REFERENCES public.safe_zones(id);

-- Store the exact GPS fix used to confirm arrival. The UI may display it, but
-- release authorization relies on this server-validated record.
CREATE OR REPLACE FUNCTION public.record_safe_arrival(
  p_transaction_id uuid,
  p_role text,
  p_lat numeric,
  p_lng numeric
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  actor uuid := auth.uid();
  tx public.transactions%ROWTYPE;
  uni text;
  z record;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_role NOT IN ('buyer','seller') THEN RAISE EXCEPTION 'Invalid arrival role'; END IF;
  IF p_lat IS NULL OR p_lng IS NULL OR p_lat NOT BETWEEN -90 AND 90 OR p_lng NOT BETWEEN -180 AND 180 THEN
    RAISE EXCEPTION 'Invalid coordinates';
  END IF;

  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  IF (p_role='buyer' AND tx.buyer_id<>actor) OR (p_role='seller' AND tx.seller_id<>actor) THEN
    RAISE EXCEPTION 'Not authorized for this transaction';
  END IF;
  SELECT university INTO uni FROM public.profiles WHERE id=actor;
  IF uni IS NULL THEN RAISE EXCEPTION 'University is required for safe-zone validation'; END IF;

  SELECT * INTO z FROM public.is_in_safe_swap_zone(p_lat,p_lng,uni) LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success',false,'within_safe_zone',false,'message','Outside an approved 50m Safe Swap Zone');
  END IF;

  IF p_role='buyer' THEN
    UPDATE public.transactions
    SET buyer_arrived=true,buyer_arrival_time=now(),buyer_lat=p_lat,buyer_lng=p_lng,
        buyer_location_captured_at=now(),buyer_safe_zone_id=z.zone_id
    WHERE id=tx.id;
  ELSE
    UPDATE public.transactions
    SET seller_arrived=true,seller_arrival_time=now(),seller_lat=p_lat,seller_lng=p_lng,
        seller_location_captured_at=now(),seller_safe_zone_id=z.zone_id
    WHERE id=tx.id;
  END IF;

  RETURN jsonb_build_object('success',true,'within_safe_zone',true,'zone_id',z.zone_id,'zone_name',z.zone_name,'distance_m',z.distance_m);
END; $$;
REVOKE ALL ON FUNCTION public.record_safe_arrival(uuid,text,numeric,numeric) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.record_safe_arrival(uuid,text,numeric,numeric) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Preserve the authoritative 032 escrow state machine, adding only the
--    server-side Safe Swap Zone check to buyer QR release.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.process_escrow_action(
  p_transaction_id uuid,p_action text,p_qr_secret text DEFAULT NULL,p_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  tx public.transactions%ROWTYPE;
  actor uuid:=auth.uid();
  privileged boolean:=(auth.role()='service_role');
  previous_status text;
  safe_zone record;
BEGIN
  IF actor IS NULL AND NOT privileged THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO tx FROM public.transactions WHERE id=p_transaction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transaction not found'; END IF;
  previous_status:=tx.status;
  IF NOT privileged AND actor<>tx.buyer_id AND actor<>tx.seller_id THEN RAISE EXCEPTION 'Not authorized for this transaction'; END IF;

  IF COALESCE((tx.metadata->>'duress_active')::boolean,false) AND p_action IN ('release','auto_release','request_release') THEN
    RAISE EXCEPTION 'Escrow is frozen by a safety alert';
  END IF;

  CASE p_action
    WHEN 'initiate_meetup' THEN
      IF privileged OR actor<>tx.seller_id THEN RAISE EXCEPTION 'Only the seller can initiate the meetup'; END IF;
      IF tx.status<>'locked' THEN RAISE EXCEPTION 'Meetup can only start from locked state'; END IF;
      UPDATE public.transactions SET status='meetup_initiated',meetup_initiated_at=COALESCE(meetup_initiated_at,now()) WHERE id=tx.id;
    WHEN 'request_release' THEN
      IF privileged OR actor<>tx.seller_id THEN RAISE EXCEPTION 'Only the seller can request release'; END IF;
      IF tx.status<>'meetup_initiated' THEN RAISE EXCEPTION 'Release can only be requested after meetup initiation'; END IF;
      IF tx.meetup_initiated_at IS NULL OR tx.meetup_initiated_at>now()-interval '24 hours' THEN RAISE EXCEPTION '24-hour release gate has not elapsed'; END IF;
      UPDATE public.transactions SET status='release_requested',release_requested_at=COALESCE(release_requested_at,now()),auto_release_at=now()+interval '48 hours' WHERE id=tx.id;
    WHEN 'release' THEN
      IF privileged OR actor<>tx.buyer_id THEN RAISE EXCEPTION 'Only the buyer can release escrow'; END IF;
      IF tx.status<>'meetup_initiated' THEN RAISE EXCEPTION 'Escrow is not ready for buyer release'; END IF;
      IF p_qr_secret IS NULL OR p_qr_secret<>COALESCE(tx.qr_secret,tx.release_code) THEN RAISE EXCEPTION 'Invalid release credential'; END IF;
      IF tx.buyer_lat IS NULL OR tx.buyer_lng IS NULL OR tx.buyer_location_captured_at IS NULL
         OR tx.buyer_location_captured_at < now()-interval '10 minutes' THEN
        RAISE EXCEPTION 'Safe Swap location is missing or stale';
      END IF;
      SELECT * INTO safe_zone FROM public.is_in_safe_swap_zone(
        tx.buyer_lat,tx.buyer_lng,(SELECT university FROM public.profiles WHERE id=tx.buyer_id)
      ) LIMIT 1;
      IF NOT FOUND THEN RAISE EXCEPTION 'QR release is only allowed inside an approved 50m Safe Swap Zone'; END IF;
      UPDATE public.transactions SET status='released',released_at=now(),completed_at=now(),buyer_safe_zone_id=safe_zone.zone_id WHERE id=tx.id;
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.seller_id,tx.amount,'Escrow release',tx.id) ON CONFLICT DO NOTHING;
    WHEN 'dispute' THEN
      IF privileged OR actor<>tx.buyer_id THEN RAISE EXCEPTION 'Only the buyer can dispute'; END IF;
      IF tx.status<>'release_requested' THEN RAISE EXCEPTION 'Transaction is not in the dispute window'; END IF;
      IF tx.auto_release_at IS NOT NULL AND tx.auto_release_at<=now() THEN RAISE EXCEPTION 'Dispute window has expired'; END IF;
      IF p_reason IS NULL OR length(trim(p_reason))<20 THEN RAISE EXCEPTION 'Dispute reason must be at least 20 characters'; END IF;
      UPDATE public.transactions SET status='disputed',disputed_at=now(),dispute_reason=trim(p_reason) WHERE id=tx.id;
    WHEN 'refund' THEN
      IF NOT privileged THEN RAISE EXCEPTION 'Refund is an administrative action'; END IF;
      IF tx.status NOT IN('locked','meetup_initiated','release_requested','disputed') THEN RAISE EXCEPTION 'Transaction cannot be refunded'; END IF;
      UPDATE public.transactions SET status='cancelled',cancelled_at=now() WHERE id=tx.id;
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.buyer_id,tx.amount,'Escrow refund',tx.id) ON CONFLICT DO NOTHING;
    WHEN 'auto_release' THEN
      IF NOT privileged THEN RAISE EXCEPTION 'Auto-release is service-only'; END IF;
      IF tx.status<>'release_requested' OR tx.auto_release_at IS NULL OR tx.auto_release_at>now() THEN RAISE EXCEPTION 'Transaction is not due for auto-release'; END IF;
      UPDATE public.transactions SET status='released',released_at=now(),completed_at=now() WHERE id=tx.id;
      INSERT INTO public.plug_credit_ledger(user_id,amount,reason,reference_id) VALUES(tx.seller_id,tx.amount,'Escrow auto-release',tx.id) ON CONFLICT DO NOTHING;
    ELSE RAISE EXCEPTION 'Invalid escrow action: %',p_action;
  END CASE;

  INSERT INTO public.audit_logs(user_id,entity_type,entity_id,action,metadata)
  VALUES(COALESCE(actor,tx.seller_id),'transaction',tx.id,'escrow_'||p_action,jsonb_build_object('previous_status',previous_status));
  RETURN jsonb_build_object('success',true,'transaction_id',tx.id,'action',p_action);
END; $$;
REVOKE ALL ON FUNCTION public.process_escrow_action(uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.process_escrow_action(uuid,text,text,text) TO authenticated,service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Marketplace hostel field + departmental leaderboard
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS hostel text;
CREATE INDEX IF NOT EXISTS listings_university_hostel_idx
  ON public.listings(university,hostel,created_at DESC);

CREATE OR REPLACE FUNCTION public.get_department_leaderboard(p_university text)
RETURNS TABLE(rank bigint, department text, students bigint, avg_plug_score numeric, total_plug_score bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT row_number() OVER (ORDER BY avg(COALESCE(p.plug_score,0)) DESC, count(*) DESC) AS rank,
         p.department,
         count(*) AS students,
         round(avg(COALESCE(p.plug_score,0)),1) AS avg_plug_score,
         sum(COALESCE(p.plug_score,0))::bigint AS total_plug_score
  FROM public.profiles p
  WHERE p.university=p_university AND NULLIF(trim(p.department),'') IS NOT NULL
  GROUP BY p.department
  ORDER BY avg(COALESCE(p.plug_score,0)) DESC, count(*) DESC
  LIMIT 10
$$;
REVOKE ALL ON FUNCTION public.get_department_leaderboard(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_department_leaderboard(text) TO authenticated;

-- Hyper-local gig discovery is represented by a stable category vocabulary;
-- existing gigs.category remains free text for backwards compatibility.
CREATE TABLE IF NOT EXISTS public.campus_gig_categories (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  university text NOT NULL,
  slug text NOT NULL,
  label text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(university,slug)
);
ALTER TABLE public.campus_gig_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Campus gig categories public read" ON public.campus_gig_categories;
CREATE POLICY "Campus gig categories public read" ON public.campus_gig_categories FOR SELECT USING (active=true);

INSERT INTO public.campus_gig_categories(university,slug,label) VALUES
('University of Lagos','gst-summary','GST 101/102 Summary Notes'),
('University of Lagos','engineering-drawing-board','Engineering Drawing Board Rental'),
('University of Lagos','lab-coat-goggles','Lab Coat & Safety Goggles'),
('University of Lagos','departmental-printing','Departmental Printing / Binding'),
('University of Lagos','past-questions','Past Questions & Revision Packs')
ON CONFLICT (university,slug) DO NOTHING;
