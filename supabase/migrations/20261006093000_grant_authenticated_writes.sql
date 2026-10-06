-- Campus Plug: add INSERT/UPDATE/DELETE for study_pools and profile_ratings.
-- The previous migration only granted SELECT, which broke StudyPools create
-- and ProfileRating upsert with 42501.

GRANT INSERT, UPDATE, DELETE ON TABLE public.study_pools TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.profile_ratings TO authenticated;
