-- Campus Plug — grant authenticated reads for university linking
-- Fixes 42501 on allowed_domains, study_pools, profile_ratings

GRANT SELECT ON TABLE public.allowed_domains TO authenticated;
GRANT SELECT ON TABLE public.study_pools TO authenticated;
GRANT SELECT ON TABLE public.profile_ratings TO authenticated;
