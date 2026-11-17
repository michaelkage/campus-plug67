-- Campus Plug: grant authenticated access to social/academic tables.
-- Migration 050+ created these tables but never granted privileges to
-- `authenticated`, so RLS policies were unreachable and INSERT/SELECT
-- returned 42501 permission denied.

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_chats TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_chat_members TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.group_chat_messages TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.study_notes TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.class_alerts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.campus_locations TO authenticated;
