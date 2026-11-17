-- Harden self-join membership writes.
-- CampusHub now uses INSERT (not UPSERT), because cohort members may already
-- have a row and the table intentionally has no client UPDATE policy.
-- A student may join as a member only within their own university; only the
-- creator of a group may add their own owner membership.
DROP POLICY IF EXISTS "Users join groups" ON public.group_chat_members;
DROP POLICY IF EXISTS "Users join own campus groups" ON public.group_chat_members;

CREATE POLICY "Users join own campus groups"
ON public.group_chat_members
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.group_chats AS g
    JOIN public.profiles AS p ON p.id = (SELECT auth.uid())
    WHERE g.id = group_chat_members.group_id
      AND g.university = p.university
      AND (
        group_chat_members.role = 'member'
        OR (group_chat_members.role = 'owner' AND g.creator_id = (SELECT auth.uid()))
      )
  )
);
