-- Campus verification fallback: private evidence review with supplemental peer vouches.
-- Account email confirmation is separate from institution membership verification.

CREATE TABLE IF NOT EXISTS public.campus_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  matric_number text NOT NULL,
  evidence_path text NOT NULL UNIQUE,
  evidence_mime_type text NOT NULL CHECK (evidence_mime_type IN ('image/jpeg','image/png','image/webp','application/pdf')),
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','rejected')),
  review_reason text,
  reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  evidence_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status IN ('approved','rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CHECK (length(matric_number) BETWEEN 4 AND 32)
);
CREATE UNIQUE INDEX IF NOT EXISTS campus_verification_one_pending_per_institution_uidx
  ON public.campus_verification_requests(user_id,institution_id)
  WHERE status = 'pending_review';
CREATE INDEX IF NOT EXISTS campus_verification_queue_idx
  ON public.campus_verification_requests(status,submitted_at ASC);
CREATE INDEX IF NOT EXISTS campus_verification_owner_idx
  ON public.campus_verification_requests(user_id,submitted_at DESC);

CREATE TABLE IF NOT EXISTS public.campus_verification_vouches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.campus_verification_requests(id) ON DELETE CASCADE,
  voucher_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  institution_id uuid NOT NULL REFERENCES public.institutions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,voucher_id)
);
CREATE INDEX IF NOT EXISTS campus_verification_vouches_request_idx
  ON public.campus_verification_vouches(request_id,created_at DESC);

CREATE TABLE IF NOT EXISTS public.campus_verification_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.campus_verification_requests(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('submitted','vouched','approved','rejected')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campus_verification_audit_request_idx
  ON public.campus_verification_audit(request_id,created_at DESC);

ALTER TABLE public.campus_verification_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campus_verification_vouches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campus_verification_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Applicants and platform admins read campus verification requests" ON public.campus_verification_requests;
CREATE POLICY "Applicants and platform admins read campus verification requests"
  ON public.campus_verification_requests FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_platform_admin());

DROP POLICY IF EXISTS "Platform admins read campus verification vouches" ON public.campus_verification_vouches;
CREATE POLICY "Platform admins read campus verification vouches"
  ON public.campus_verification_vouches FOR SELECT TO authenticated
  USING (public.is_platform_admin());

DROP POLICY IF EXISTS "Platform admins read campus verification audit" ON public.campus_verification_audit;
CREATE POLICY "Platform admins read campus verification audit"
  ON public.campus_verification_audit FOR SELECT TO authenticated
  USING (public.is_platform_admin());

REVOKE ALL ON public.campus_verification_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.campus_verification_requests TO authenticated;
REVOKE ALL ON public.campus_verification_vouches FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.campus_verification_vouches TO authenticated;
REVOKE ALL ON public.campus_verification_audit FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.campus_verification_audit TO authenticated;

-- Private evidence bucket. Paths are {auth.uid}/{institution_id}/{uuid}.{ext}.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES (
  'campus-verification-evidence',
  'campus-verification-evidence',
  false,
  5242880,
  ARRAY['image/jpeg','image/png','image/webp','application/pdf']
)
ON CONFLICT(id) DO UPDATE
SET public = false,
    file_size_limit = 5242880,
    allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','application/pdf'];

DROP POLICY IF EXISTS "Applicants upload own campus verification evidence" ON storage.objects;
CREATE POLICY "Applicants upload own campus verification evidence"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'campus-verification-evidence'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND array_length(storage.foldername(name),1) = 2
  );

DROP POLICY IF EXISTS "Applicants and admins read campus verification evidence" ON storage.objects;
CREATE POLICY "Applicants and admins read campus verification evidence"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'campus-verification-evidence'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR public.is_platform_admin()
    )
  );

DROP POLICY IF EXISTS "Platform admins delete campus verification evidence" ON storage.objects;
DROP POLICY IF EXISTS "Applicants delete unclaimed and admins delete campus verification evidence" ON storage.objects;
CREATE POLICY "Applicants delete unclaimed and admins delete campus verification evidence"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'campus-verification-evidence'
    AND (
      public.is_platform_admin()
      OR (
        owner_id = auth.uid()::text
        AND NOT EXISTS (
          SELECT 1 FROM public.campus_verification_requests r
          WHERE r.evidence_path = name
        )
      )
    )
  );

-- The legacy membership constraint required an email address for every verified
-- member. Manual review has no institutional email, so permit NULL only for the
-- explicitly named manual-review method.
DO $$
DECLARE existing_constraint text;
BEGIN
  SELECT conname INTO existing_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.institution_memberships'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%verified_email IS NOT NULL%'
  LIMIT 1;
  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.institution_memberships DROP CONSTRAINT %I', existing_constraint);
  END IF;
END $$;
ALTER TABLE public.institution_memberships
  ADD CONSTRAINT institution_memberships_verification_evidence_check
  CHECK (
    (status = 'verified' AND verified_at IS NOT NULL
      AND (
        (verification_method = 'verified_email_domain' AND verified_email IS NOT NULL)
        OR (verification_method = 'manual_evidence_review' AND verified_email IS NULL)
      ))
    OR status <> 'verified'
  );

CREATE OR REPLACE FUNCTION public.submit_my_campus_verification(
  p_institution_id uuid,
  p_matric_number text,
  p_evidence_path text,
  p_evidence_mime_type text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, storage
AS $$
DECLARE
  actor uuid := auth.uid();
  normalized_matric text := upper(regexp_replace(trim(COALESCE(p_matric_number,'')), '\s+', '', 'g'));
  request_row public.campus_verification_requests%ROWTYPE;
  confirmed_at timestamptz;
  request_count integer;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text || ':campus-verification', 0));

  SELECT email_confirmed_at INTO confirmed_at FROM auth.users WHERE id = actor;
  IF confirmed_at IS NULL THEN RAISE EXCEPTION 'Confirm your account email before submitting campus evidence'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.institutions WHERE id = p_institution_id AND is_active) THEN
    RAISE EXCEPTION 'Select an active institution from the campus directory';
  END IF;
  IF normalized_matric !~ '^[A-Z0-9/-]{4,32}$' THEN
    RAISE EXCEPTION 'Enter a valid matric number using 4 to 32 letters, numbers, hyphens or slashes';
  END IF;
  IF p_evidence_mime_type IS NULL OR p_evidence_mime_type NOT IN ('image/jpeg','image/png','image/webp','application/pdf') THEN
    RAISE EXCEPTION 'Unsupported evidence file type';
  END IF;
  IF p_evidence_path !~ ('^' || actor::text || '/' || p_institution_id::text || '/[0-9a-fA-F-]{36}\.(jpg|jpeg|png|webp|pdf)$') THEN
    RAISE EXCEPTION 'Evidence path is not scoped to this account and institution';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o
    WHERE o.bucket_id = 'campus-verification-evidence'
      AND o.name = p_evidence_path
      AND o.owner_id = actor::text
  ) THEN
    RAISE EXCEPTION 'Upload your private evidence file before submitting';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.institution_memberships
    WHERE user_id = actor AND institution_id = p_institution_id AND status = 'verified'
  ) THEN
    RAISE EXCEPTION 'You already have a verified membership at this institution';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.institution_memberships
    WHERE user_id = actor AND institution_id = p_institution_id AND status = 'suspended'
  ) THEN RAISE EXCEPTION 'This campus membership is suspended and requires a separate appeal process'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.campus_verification_requests
    WHERE user_id = actor AND institution_id = p_institution_id AND status = 'pending_review'
  ) THEN
    RAISE EXCEPTION 'A campus verification request is already awaiting review';
  END IF;

  SELECT count(*) INTO request_count
  FROM public.campus_verification_requests
  WHERE user_id = actor AND submitted_at > now() - interval '30 days';
  IF request_count >= 3 THEN RAISE EXCEPTION 'Campus verification submission limit reached. Try again later'; END IF;

  INSERT INTO public.campus_verification_requests(
    user_id,institution_id,matric_number,evidence_path,evidence_mime_type
  ) VALUES (
    actor,p_institution_id,normalized_matric,p_evidence_path,p_evidence_mime_type
  ) RETURNING * INTO request_row;

  INSERT INTO public.institution_memberships(user_id,institution_id,status,verification_method)
  VALUES(actor,p_institution_id,'pending','manual_evidence_review')
  ON CONFLICT(user_id,institution_id) DO UPDATE
    SET status = CASE WHEN public.institution_memberships.status = 'suspended'
      THEN 'suspended' ELSE 'pending' END,
      verification_method = CASE WHEN public.institution_memberships.status = 'suspended'
      THEN public.institution_memberships.verification_method ELSE 'manual_evidence_review' END,
      updated_at = now();

  INSERT INTO public.campus_verification_audit(request_id,actor_id,action,metadata)
  VALUES(request_row.id,actor,'submitted',jsonb_build_object('institution_id',p_institution_id));

  RETURN jsonb_build_object('request_id',request_row.id,'status',request_row.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.vouch_for_campus_verification(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  target_request public.campus_verification_requests%ROWTYPE;
  account_created_at timestamptz;
  recent_vouches integer;
  total_vouches integer;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(actor::text || ':campus-vouch', 0));
  SELECT * INTO target_request FROM public.campus_verification_requests
  WHERE id = p_request_id AND status = 'pending_review' FOR UPDATE;
  IF target_request.id IS NULL THEN RAISE EXCEPTION 'Pending campus request not found'; END IF;
  IF target_request.user_id = actor THEN RAISE EXCEPTION 'You cannot vouch for your own request'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.institution_memberships
    WHERE user_id = actor AND institution_id = target_request.institution_id AND status = 'verified'
  ) THEN RAISE EXCEPTION 'Only verified members of the same institution can vouch'; END IF;

  SELECT created_at INTO account_created_at FROM auth.users WHERE id = actor;
  IF account_created_at IS NULL OR account_created_at > now() - interval '30 days' THEN
    RAISE EXCEPTION 'Your account must be at least 30 days old before vouching';
  END IF;
  SELECT count(*) INTO recent_vouches FROM public.campus_verification_vouches
  WHERE voucher_id = actor AND created_at > now() - interval '30 days';
  IF recent_vouches >= 5 THEN RAISE EXCEPTION 'Vouching limit reached for this month'; END IF;

  INSERT INTO public.campus_verification_vouches(request_id,voucher_id,institution_id)
  VALUES(p_request_id,actor,target_request.institution_id)
  ON CONFLICT(request_id,voucher_id) DO NOTHING;
  GET DIAGNOSTICS total_vouches = ROW_COUNT;
  IF total_vouches = 0 THEN RAISE EXCEPTION 'You have already vouched for this request'; END IF;

  INSERT INTO public.campus_verification_audit(request_id,actor_id,action,metadata)
  VALUES(p_request_id,actor,'vouched',jsonb_build_object('institution_id',target_request.institution_id));
  RETURN jsonb_build_object('request_id',p_request_id,'vouched',true);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_campus_verification_review_queue()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE result jsonb;
BEGIN
  IF NOT public.is_platform_admin() THEN RAISE EXCEPTION 'Platform admin required'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(q) ORDER BY q.submitted_at ASC),'[]'::jsonb)
  INTO result
  FROM (
    SELECT r.id,r.user_id,r.institution_id,r.matric_number,r.evidence_path,
      r.evidence_mime_type,r.status,r.review_reason,r.submitted_at,
      i.name AS institution_name,p.full_name AS applicant_name,p.email AS applicant_email,
      (SELECT count(*) FROM public.campus_verification_vouches v WHERE v.request_id=r.id) AS vouch_count,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object('name',vp.full_name,'account_created_at',vu.created_at) ORDER BY v.created_at)
        FROM public.campus_verification_vouches v
        JOIN public.profiles vp ON vp.id=v.voucher_id
        JOIN auth.users vu ON vu.id=v.voucher_id
        WHERE v.request_id=r.id
      ),'[]'::jsonb) AS peer_vouches
    FROM public.campus_verification_requests r
    JOIN public.institutions i ON i.id=r.institution_id
    JOIN public.profiles p ON p.id=r.user_id
    WHERE r.status='pending_review'
  ) q;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_campus_verification_request(
  p_request_id uuid,
  p_decision text,
  p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  actor uuid := auth.uid();
  request_row public.campus_verification_requests%ROWTYPE;
  primary_id uuid;
BEGIN
  IF actor IS NULL OR NOT public.is_platform_admin() THEN RAISE EXCEPTION 'Platform admin required'; END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Invalid review decision'; END IF;
  IF p_decision='rejected' AND length(trim(COALESCE(p_reason,''))) < 8 THEN
    RAISE EXCEPTION 'Provide a clear rejection reason of at least 8 characters';
  END IF;
  IF length(COALESCE(p_reason,'')) > 1000 THEN RAISE EXCEPTION 'Review reason is too long'; END IF;

  SELECT * INTO request_row FROM public.campus_verification_requests
  WHERE id=p_request_id FOR UPDATE;
  IF request_row.id IS NULL OR request_row.status <> 'pending_review' THEN
    RAISE EXCEPTION 'Request is no longer awaiting review';
  END IF;
  IF p_decision='approved' AND NOT EXISTS (
    SELECT 1 FROM storage.objects
    WHERE bucket_id='campus-verification-evidence' AND name=request_row.evidence_path
  ) THEN RAISE EXCEPTION 'Evidence file is missing; request cannot be approved'; END IF;

  IF EXISTS (
    SELECT 1 FROM public.institution_memberships
    WHERE user_id=request_row.user_id AND institution_id=request_row.institution_id AND status='suspended'
  ) THEN RAISE EXCEPTION 'This campus membership is suspended and requires a separate appeal process'; END IF;

  UPDATE public.campus_verification_requests
  SET status=p_decision,review_reason=NULLIF(trim(p_reason),''),reviewed_by=actor,
      reviewed_at=now(),updated_at=now()
  WHERE id=p_request_id;

  IF p_decision='approved' THEN
    INSERT INTO public.institution_memberships(
      user_id,institution_id,status,verification_method,verified_email,verified_at,is_primary
    ) VALUES (
      request_row.user_id,request_row.institution_id,'verified','manual_evidence_review',NULL,now(),false
    )
    ON CONFLICT(user_id,institution_id) DO UPDATE
      SET status='verified',verification_method='manual_evidence_review',
          verified_email=NULL,verified_at=now(),updated_at=now()
      WHERE public.institution_memberships.status <> 'suspended';

    SELECT primary_institution_id INTO primary_id
    FROM public.profiles WHERE id=request_row.user_id FOR UPDATE;
    IF primary_id IS NULL THEN
      PERFORM set_config('app.institution_write','on',true);
      UPDATE public.profiles
      SET primary_institution_id=request_row.institution_id,
          university=(SELECT name FROM public.institutions WHERE id=request_row.institution_id),
          updated_at=now()
      WHERE id=request_row.user_id;
      UPDATE public.institution_memberships SET is_primary=false,updated_at=now()
      WHERE user_id=request_row.user_id AND status='verified';
      UPDATE public.institution_memberships SET is_primary=true,updated_at=now()
      WHERE user_id=request_row.user_id AND institution_id=request_row.institution_id AND status='verified';
    END IF;
  ELSE
    UPDATE public.institution_memberships
    SET status='rejected',updated_at=now()
    WHERE user_id=request_row.user_id AND institution_id=request_row.institution_id
      AND status='pending';
  END IF;

  INSERT INTO public.campus_verification_audit(request_id,actor_id,action,metadata)
  VALUES(p_request_id,actor,p_decision,jsonb_build_object('reason',NULLIF(trim(p_reason),'')));

  RETURN jsonb_build_object('request_id',p_request_id,'status',p_decision);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_my_campus_verification(uuid,text,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_my_campus_verification(uuid,text,text,text) TO authenticated;
REVOKE ALL ON FUNCTION public.vouch_for_campus_verification(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.vouch_for_campus_verification(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.get_campus_verification_review_queue() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_campus_verification_review_queue() TO authenticated;
REVOKE ALL ON FUNCTION public.review_campus_verification_request(uuid,text,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.review_campus_verification_request(uuid,text,text) TO authenticated;

COMMENT ON TABLE public.campus_verification_requests IS
  'Private, owner/admin-readable requests for manual campus membership verification. Matric numbers and evidence paths are sensitive.';
COMMENT ON TABLE public.campus_verification_vouches IS
  'Supplemental same-institution peer attestations. Vouches never approve membership automatically.';
COMMENT ON TABLE public.campus_verification_audit IS
  'Append-only audit trail for campus verification submissions, peer vouches and reviewer decisions.';
