-- Migration: Fix wallet ledger grants and add user department search

-- 1. Grant service_role access to plug_credit_ledger (needed for RPC success)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.plug_credit_ledger TO service_role;

-- 2. Create search_users_by_department function
CREATE OR REPLACE FUNCTION public.search_users_by_department(p_department text)
RETURNS SETOF public.profiles
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  -- Search for users in the same department as the current user,
  -- and also restrict to the same university as the current user.
  SELECT p.* 
  FROM public.profiles p
  JOIN public.profiles current_user_profile ON current_user_profile.id = auth.uid()
  WHERE p.department = p_department
    AND p.university = current_user_profile.university
    AND p.id != auth.uid();
$$;

-- Grant access to authenticated users
GRANT EXECUTE ON FUNCTION public.search_users_by_department(text) TO authenticated;
