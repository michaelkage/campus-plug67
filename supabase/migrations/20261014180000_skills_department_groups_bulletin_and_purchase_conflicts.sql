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

-- Normalize legacy programme-valued profiles.department into faculty labels used by current onboarding.
-- Profile data stays untouched; existing groups and new profiles resolve to the same scope.
CREATE OR REPLACE FUNCTION public.canonical_academic_department(p_department text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public AS $
  SELECT CASE trim(COALESCE(p_department, ''))
    WHEN '' THEN 'General'
    WHEN 'Agricultural Engineering' THEN 'Engineering'
    WHEN 'Chemical Engineering' THEN 'Engineering'
    WHEN 'Civil Engineering' THEN 'Engineering'
    WHEN 'Computer Engineering' THEN 'Engineering'
    WHEN 'Electrical/Electronics Engineering' THEN 'Engineering'
    WHEN 'Mechanical Engineering' THEN 'Engineering'
    WHEN 'Biochemistry' THEN 'Sciences'
    WHEN 'Biology' THEN 'Sciences'
    WHEN 'Chemistry' THEN 'Sciences'
    WHEN 'Computer Science' THEN 'Sciences'
    WHEN 'Geology' THEN 'Sciences'
    WHEN 'Industrial Chemistry' THEN 'Sciences'
    WHEN 'Mathematics' THEN 'Sciences'
    WHEN 'Microbiology' THEN 'Sciences'
    WHEN 'Physics' THEN 'Sciences'
    WHEN 'Statistics' THEN 'Sciences'
    WHEN 'Anatomy' THEN 'Medicine & Health Sciences'
    WHEN 'Dentistry' THEN 'Medicine & Health Sciences'
    WHEN 'Human Anatomy' THEN 'Medicine & Health Sciences'
    WHEN 'Medical Laboratory Science' THEN 'Medicine & Health Sciences'
    WHEN 'Medicine and Surgery' THEN 'Medicine & Health Sciences'
    WHEN 'Nursing Science' THEN 'Medicine & Health Sciences'
    WHEN 'Pharmacy' THEN 'Medicine & Health Sciences'
    WHEN 'Physiology' THEN 'Medicine & Health Sciences'
    WHEN 'Veterinary Medicine' THEN 'Medicine & Health Sciences'
    WHEN 'English and Literary Studies' THEN 'Arts & Humanities'
    WHEN 'English' THEN 'Arts & Humanities'
    WHEN 'History' THEN 'Arts & Humanities'
    WHEN 'Linguistics' THEN 'Arts & Humanities'
    WHEN 'Philosophy' THEN 'Arts & Humanities'
    WHEN 'Theatre Arts' THEN 'Arts & Humanities'
    WHEN 'Fine Arts' THEN 'Arts & Humanities'
    WHEN 'Economics' THEN 'Social Sciences'
    WHEN 'Geography' THEN 'Social Sciences'
    WHEN 'Political Science' THEN 'Social Sciences'
    WHEN 'Psychology' THEN 'Social Sciences'
    WHEN 'Sociology' THEN 'Social Sciences'
    WHEN 'Mass Communication' THEN 'Social Sciences'
    WHEN 'Accounting' THEN 'Management Sciences'
    WHEN 'Banking and Finance' THEN 'Management Sciences'
    WHEN 'Business Administration' THEN 'Management Sciences'
    WHEN 'Finance' THEN 'Management Sciences'
    WHEN 'Insurance' THEN 'Management Sciences'
    WHEN 'Marketing' THEN 'Management Sciences'
    WHEN 'Public Administration' THEN 'Management Sciences'
    WHEN 'Industrial Relations' THEN 'Management Sciences'
    WHEN 'Adult Education' THEN 'Education'
    WHEN 'Education' THEN 'Education'
    WHEN 'Guidance and Counselling' THEN 'Education'
    WHEN 'Architecture' THEN 'Environmental Sciences'
    WHEN 'Building' THEN 'Environmental Sciences'
    WHEN 'Estate Management' THEN 'Environmental Sciences'
    WHEN 'Quantity Surveying' THEN 'Environmental Sciences'
    WHEN 'Surveying and Geoinformatics' THEN 'Environmental Sciences'
    WHEN 'Urban and Regional Planning' THEN 'Environmental Sciences'
    WHEN 'Agricultural Economics' THEN 'Agriculture & Food Sciences'
    WHEN 'Agriculture' THEN 'Agriculture & Food Sciences'
    WHEN 'Fisheries' THEN 'Agriculture & Food Sciences'
    WHEN 'Food Science and Technology' THEN 'Agriculture & Food Sciences'
    WHEN 'Law' THEN 'Law'
    WHEN 'Other' THEN 'Other'
    WHEN 'Engineering' THEN 'Engineering'
    WHEN 'Sciences' THEN 'Sciences'
    WHEN 'Medicine & Health Sciences' THEN 'Medicine & Health Sciences'
    WHEN 'Arts & Humanities' THEN 'Arts & Humanities'
    WHEN 'Social Sciences' THEN 'Social Sciences'
    WHEN 'Management Sciences' THEN 'Management Sciences'
    WHEN 'Environmental Sciences' THEN 'Environmental Sciences'
    WHEN 'Agriculture & Food Sciences' THEN 'Agriculture & Food Sciences'
    ELSE trim(p_department)
  END
$;

-- Study groups: a group is visible only to students in its department at that university.
ALTER TABLE public.group_chats ADD COLUMN IF NOT EXISTS department text;
UPDATE public.group_chats gc
SET department = COALESCE(NULLIF(trim(p.department), ''), 'General')
FROM public.profiles p
WHERE p.id = gc.creator_id AND gc.department IS NULL;
UPDATE public.group_chats SET department = 'General' WHERE department IS NULL;
UPDATE public.group_chats SET department = public.canonical_academic_department(department);
ALTER TABLE public.group_chats ALTER COLUMN department SET DEFAULT 'General';
CREATE INDEX IF NOT EXISTS group_chats_department_idx
  ON public.group_chats(university, department, is_archived, last_activity_at DESC);

DROP POLICY IF EXISTS "Group chats visible to university" ON public.group_chats;
CREATE POLICY "Group chats visible to matching department"
  ON public.group_chats FOR SELECT TO authenticated
  USING (
    university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
    AND department = public.canonical_academic_department(
      (SELECT p.department FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
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
        AND g.department = public.canonical_academic_department(p.department)
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
  FOR DELETE TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    AND university = (SELECT p.university FROM public.profiles p WHERE p.id = (SELECT auth.uid()))
  );

-- Wallet purchase RPCs are intentionally not redefined here.
-- Later migrations on main own these functions and include listing reservation,
-- ledger idempotency, constraint-specific conflict mapping, and settlement checks.
-- Replacing them in this feature migration would silently regress those safeguards.
