-- Campus Plug: marketplace permissions, academic profiles, cohort groups and categorisation
-- Apply after the existing schema migrations. RLS remains enabled.

-- Explicit Data API privileges required by Supabase PostgREST.
grant select, insert, update, delete on table public.gigs to authenticated;
grant select on table public.gigs to anon;

-- Keep row-level protections in force; authenticated users may only mutate their own gigs.
alter table public.gigs enable row level security;
drop policy if exists "Gigs viewable by all" on public.gigs;
create policy "Gigs view active listings" on public.gigs
  for select to anon, authenticated using (active = true or auth.uid() = seller_id);
drop policy if exists "Auth users create gigs" on public.gigs;
create policy "Sellers create own gigs" on public.gigs
  for insert to authenticated with check (auth.uid() = seller_id);
drop policy if exists "Sellers update own gigs" on public.gigs;
create policy "Sellers update own gigs" on public.gigs
  for update to authenticated using (auth.uid() = seller_id) with check (auth.uid() = seller_id);
drop policy if exists "Sellers delete own gigs" on public.gigs;
create policy "Sellers delete own gigs" on public.gigs
  for delete to authenticated using (auth.uid() = seller_id);

-- Academic course is separate from department. Existing profiles remain valid.
alter table public.profiles add column if not exists course text;
create index if not exists profiles_university_department_idx
  on public.profiles (university, department);
create index if not exists profiles_university_course_idx
  on public.profiles (university, course);

-- Stable category normalisation for common preset products; unknown products stay untouched.
create or replace function public.campus_plug_suggest_category(p_title text)
returns table(category text, subcategory text)
language sql immutable
set search_path = public
as $$
  select case
    when lower(coalesce(p_title,'')) ~ '(oraimo|boom pop|power bank|charger|earbud|earphone|headphone|bluetooth speaker|smart watch|usb drive|flash drive|keyboard|mouse|monitor|laptop|phone|tablet|gamepad|controller|console|router|projector)'
      then 'Electronics & Tech'
    when lower(coalesce(p_title,'')) ~ '(textbook|lecture note|past question|workbook|calculator|lab coat|drawing board|stationery|notebook|pen set)'
      then 'Study & Academics'
    when lower(coalesce(p_title,'')) ~ '(shoe|sneaker|shirt|jean|trouser|hoodie|dress|bag|watch)'
      then 'Fashion & Lifestyle'
    when lower(coalesce(p_title,'')) ~ '(rice cooker|blender|kettle|microwave|fan|fridge|mattress|chair|table|bedsheet)'
      then 'Room & Living'
    when lower(coalesce(p_title,'')) ~ '(football|basketball|dumbbell|bicycle|bike|tennis racket)'
      then 'Sports & Outdoors'
    else 'Other'
  end,
  case
    when lower(coalesce(p_title,'')) ~ '(oraimo|boom pop|bluetooth speaker|speaker)' then 'Audio & Speakers'
    when lower(coalesce(p_title,'')) ~ '(power bank|charger|cable|adapter)' then 'Charging & Power'
    when lower(coalesce(p_title,'')) ~ '(earbud|earphone|headphone)' then 'Headphones & Earbuds'
    when lower(coalesce(p_title,'')) ~ '(laptop|keyboard|mouse|monitor|usb drive|flash drive)' then 'Computer Accessories'
    when lower(coalesce(p_title,'')) ~ '(phone|tablet|smart watch)' then 'Phones & Wearables'
    when lower(coalesce(p_title,'')) ~ '(textbook|lecture note|past question|workbook)' then 'Books & Course Materials'
    else null
  end;
$$;

-- Automatic cohort GCs. Groups are created lazily and membership is idempotent.
-- The trigger only runs when the student has university + department; course group
-- enrolment additionally requires a non-empty course.
create or replace function public.sync_student_cohort_groups()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  dept_group_id uuid;
  course_group_id uuid;
  dept_name text;
  course_name text;
begin
  if new.university is null or btrim(new.university) = ''
     or new.department is null or btrim(new.department) = '' then
    return new;
  end if;

  dept_name := btrim(new.department);
  insert into public.group_chats(name, university, creator_id, is_archived)
  values (new.university || ' · ' || dept_name || ' Department', new.university, new.id, false)
  on conflict do nothing;

  select id into dept_group_id from public.group_chats
   where university = new.university and lower(name) = lower(new.university || ' · ' || dept_name || ' Department')
     and is_archived = false limit 1;

  if dept_group_id is not null then
    insert into public.group_chat_members(group_id, user_id, role)
    values (dept_group_id, new.id, 'member')
    on conflict (group_id, user_id) do nothing;
  end if;

  if new.course is not null and btrim(new.course) <> '' then
    course_name := btrim(new.course);
    insert into public.group_chats(name, university, course_code, creator_id, is_archived)
    values (new.university || ' · ' || course_name, new.university, course_name, new.id, false)
    on conflict do nothing;

    select id into course_group_id from public.group_chats
     where university = new.university and course_code = course_name
       and is_archived = false limit 1;

    if course_group_id is not null then
      insert into public.group_chat_members(group_id, user_id, role)
      values (course_group_id, new.id, 'member')
      on conflict (group_id, user_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sync_student_cohort_groups on public.profiles;
create trigger sync_student_cohort_groups
after insert or update of university, department, course on public.profiles
for each row execute function public.sync_student_cohort_groups();

-- Existing profiles are backfilled through the same idempotent trigger.
update public.profiles set department = department where department is not null;

