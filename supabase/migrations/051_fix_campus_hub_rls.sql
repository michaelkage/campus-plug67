-- Campus Plug 051: harden Campus Hub RLS policies
-- Avoid recursive group membership policy evaluation.

drop policy if exists "Members see memberships" on public.group_chat_members;
create policy "Users see own memberships" on public.group_chat_members
for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists "Members read group messages" on public.group_chat_messages;
create policy "Members read group messages" on public.group_chat_messages
for select to authenticated
using (
  sender_id = (select auth.uid())
  or exists (
    select 1 from public.group_chat_members m
    where m.group_id = group_chat_messages.group_id
      and m.user_id = (select auth.uid())
  )
);

-- A member can send only as themselves and only to a group they belong to.
drop policy if exists "Members send group messages" on public.group_chat_messages;
create policy "Members send group messages" on public.group_chat_messages
for insert to authenticated
with check (
  sender_id = (select auth.uid())
  and exists (
    select 1 from public.group_chat_members m
    where m.group_id = group_chat_messages.group_id
      and m.user_id = (select auth.uid())
  )
);
