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
alter table public.listings add column if not exists subcategory text;
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


-- This function is trigger-only; do not expose its elevated execution to API roles.
revoke all on function public.sync_student_cohort_groups() from public, anon, authenticated;

-- Purchase and processing notifications are generated from trusted transaction state,
-- never from browser-supplied notification payloads.
create or replace function public.notify_transaction_parties()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item_title text;
begin
  select title into item_title from public.listings where id = new.listing_id;
  item_title := coalesce(item_title, 'your item');

  if tg_op = 'INSERT' then
    insert into public.notifications(user_id, type, title, body, data)
    values
      (new.seller_id, 'item_purchased', 'Your item has a new order',
       'A buyer has started a purchase for ' || item_title || '.',
       jsonb_build_object('transaction_id', new.id, 'listing_id', new.listing_id, 'status', new.status)),
      (new.buyer_id, 'purchase_started', 'Purchase started',
       'Your order for ' || item_title || ' has been created.',
       jsonb_build_object('transaction_id', new.id, 'listing_id', new.listing_id, 'status', new.status));
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'locked' then
      insert into public.notifications(user_id, type, title, body, data)
      values
        (new.seller_id, 'order_processing', 'Order ready for processing',
         'Payment is confirmed for ' || item_title || '. You can now process the order.',
         jsonb_build_object('transaction_id', new.id, 'listing_id', new.listing_id, 'status', new.status)),
        (new.buyer_id, 'order_processing', 'Your order is being processed',
         'Payment is confirmed. Your order for ' || item_title || ' is now being processed.',
         jsonb_build_object('transaction_id', new.id, 'listing_id', new.listing_id, 'status', new.status));
    elsif new.status in ('released', 'cancelled', 'disputed') then
      insert into public.notifications(user_id, type, title, body, data)
      values
        (new.buyer_id, 'order_status', 'Order status updated',
         'Your order for ' || item_title || ' is now ' || new.status || '.',
         jsonb_build_object('transaction_id', new.id, 'listing_id', new.listing_id, 'status', new.status)),
        (new.seller_id, 'order_status', 'Order status updated',
         'The order for ' || item_title || ' is now ' || new.status || '.',
         jsonb_build_object('transaction_id', new.id, 'listing_id', new.listing_id, 'status', new.status));
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists notify_transaction_parties on public.transactions;
create trigger notify_transaction_parties
after insert or update of status on public.transactions
for each row execute function public.notify_transaction_parties();
revoke all on function public.notify_transaction_parties() from public, anon, authenticated;
