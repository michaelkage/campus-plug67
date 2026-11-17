-- Campus Plug 050: campus social + academic utility layer
-- Adds group chat, note sharing, richer class alerts/materials, and community campus places.

create table if not exists public.group_chats (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  university text not null,
  course_code text,
  creator_id uuid references public.profiles(id) on delete cascade not null,
  last_activity_at timestamptz default now(),
  is_archived boolean default false,
  exam_archive_date timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.group_chat_members (
  group_id uuid references public.group_chats(id) on delete cascade not null,
  user_id uuid references public.profiles(id) on delete cascade not null,
  role text not null default 'member' check (role in ('owner','moderator','member')),
  joined_at timestamptz default now(),
  primary key (group_id, user_id)
);

create table if not exists public.group_chat_messages (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references public.group_chats(id) on delete cascade not null,
  sender_id uuid references public.profiles(id) on delete cascade not null,
  body text not null,
  message_type text not null default 'text' check (message_type in ('text','poll','prompt','resource','announcement')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists group_chat_messages_idx on public.group_chat_messages(group_id, created_at desc);
create index if not exists group_chat_activity_idx on public.group_chats(university, last_activity_at desc);

create table if not exists public.study_notes (
  id uuid primary key default gen_random_uuid(),
  uploader_id uuid references public.profiles(id) on delete cascade not null,
  university text not null,
  course_code text not null,
  title text not null,
  description text,
  file_url text,
  tags text[] default '{}',
  is_public boolean default true,
  download_count integer default 0,
  created_at timestamptz default now()
);

create index if not exists study_notes_course_idx on public.study_notes(university, course_code, created_at desc);

alter table public.class_alerts add column if not exists title text;
alter table public.class_alerts add column if not exists description text;
alter table public.class_alerts add column if not exists materials_needed jsonb default '[]'::jsonb;
alter table public.class_alerts add column if not exists created_by uuid references public.profiles(id);
alter table public.class_alerts add column if not exists university text;
alter table public.class_alerts add column if not exists created_at timestamptz default now();

alter table public.campus_locations add column if not exists location_type text default 'other';
alter table public.campus_locations add column if not exists description text;
alter table public.campus_locations add column if not exists verified boolean default false;
alter table public.campus_locations add column if not exists created_by uuid references public.profiles(id);
alter table public.campus_locations add column if not exists created_at timestamptz default now();

alter table public.group_chats enable row level security;
alter table public.group_chat_members enable row level security;
alter table public.group_chat_messages enable row level security;
alter table public.study_notes enable row level security;
alter table public.class_alerts enable row level security;
alter table public.campus_locations enable row level security;

create policy "Group chats visible to university" on public.group_chats for select to authenticated
using (university = (select university from public.profiles where id = (select auth.uid())));
create policy "Users create group chats" on public.group_chats for insert to authenticated
with check (creator_id = (select auth.uid()));
create policy "Owners update group chats" on public.group_chats for update to authenticated
using (creator_id = (select auth.uid())) with check (creator_id = (select auth.uid()));

create policy "Members see memberships" on public.group_chat_members for select to authenticated
using (user_id = (select auth.uid()) or exists (select 1 from public.group_chat_members m where m.group_id = group_id and m.user_id = (select auth.uid())));
create policy "Users join groups" on public.group_chat_members for insert to authenticated
with check (user_id = (select auth.uid()));
create policy "Users leave groups" on public.group_chat_members for delete to authenticated
using (user_id = (select auth.uid()));

create policy "Members read group messages" on public.group_chat_messages for select to authenticated
using (exists (select 1 from public.group_chat_members m where m.group_id = group_id and m.user_id = (select auth.uid())));
create policy "Members send group messages" on public.group_chat_messages for insert to authenticated
with check (sender_id = (select auth.uid()) and exists (select 1 from public.group_chat_members m where m.group_id = group_id and m.user_id = (select auth.uid())));

create policy "Public study notes read" on public.study_notes for select to authenticated using (is_public = true or uploader_id = (select auth.uid()));
create policy "Users upload own notes" on public.study_notes for insert to authenticated with check (uploader_id = (select auth.uid()));
create policy "Users manage own notes" on public.study_notes for update to authenticated using (uploader_id = (select auth.uid())) with check (uploader_id = (select auth.uid()));
create policy "Users delete own notes" on public.study_notes for delete to authenticated using (uploader_id = (select auth.uid()));

create policy "University users read class alerts" on public.class_alerts for select to authenticated
using (university is null or university = (select university from public.profiles where id = (select auth.uid())));
create policy "Users create class alerts" on public.class_alerts for insert to authenticated
with check (created_by = (select auth.uid()));
create policy "Creators manage class alerts" on public.class_alerts for update to authenticated
using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

create policy "University users read campus locations" on public.campus_locations for select to authenticated
using (university = (select university from public.profiles where id = (select auth.uid())) or verified = true);
create policy "Users suggest campus locations" on public.campus_locations for insert to authenticated
with check (created_by = (select auth.uid()));
create policy "Creators update suggestions" on public.campus_locations for update to authenticated
using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

alter publication supabase_realtime add table public.group_chats;
alter publication supabase_realtime add table public.group_chat_members;
alter publication supabase_realtime add table public.group_chat_messages;
alter publication supabase_realtime add table public.class_alerts;

create or replace function public.touch_group_chat_activity()
returns trigger language plpgsql as $$
begin
  update public.group_chats set last_activity_at = now() where id = new.group_id;
  return new;
end;
$$;

drop trigger if exists group_chat_activity_touch on public.group_chat_messages;
create trigger group_chat_activity_touch after insert on public.group_chat_messages
for each row execute procedure public.touch_group_chat_activity();
