-- Create a study group and its owner membership in one transaction.
-- If either insert fails, PostgreSQL rolls both back, preventing ownerless groups.
CREATE OR REPLACE FUNCTION public.create_department_group_with_owner(
  p_name text,
  p_course_code text DEFAULT NULL
)
RETURNS public.group_chats
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_profile public.profiles%ROWTYPE;
  v_group public.group_chats%ROWTYPE;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_name IS NULL OR length(trim(p_name)) NOT BETWEEN 3 AND 100 THEN
    RAISE EXCEPTION 'Group name must be between 3 and 100 characters';
  END IF;

  SELECT * INTO v_profile
  FROM public.profiles
  WHERE id = v_user;

  IF NOT FOUND OR v_profile.university IS NULL OR trim(v_profile.university) = '' THEN
    RAISE EXCEPTION 'Complete your campus profile before creating a group';
  END IF;

  INSERT INTO public.group_chats (
    name, course_code, university, department, creator_id
  )
  VALUES (
    trim(p_name),
    NULLIF(trim(COALESCE(p_course_code, '')), ''),
    v_profile.university,
    COALESCE(NULLIF(trim(v_profile.department), ''), 'General'),
    v_user
  )
  RETURNING * INTO v_group;

  INSERT INTO public.group_chat_members (group_id, user_id, role)
  VALUES (v_group.id, v_user, 'owner');

  RETURN v_group;
END;
$$;

REVOKE ALL ON FUNCTION public.create_department_group_with_owner(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_department_group_with_owner(text, text) TO authenticated;
