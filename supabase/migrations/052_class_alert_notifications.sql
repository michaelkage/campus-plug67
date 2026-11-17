-- Campus Plug 052: deliver class/program alerts to students in the same university.
-- The class_alerts table already has authenticated read access scoped by university;
-- this trigger adds an explicit notification so alerts are surfaced outside Campus Hub.

create or replace function public.notify_class_alert_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.university is null or btrim(new.university) = '' then
    return new;
  end if;

  insert into public.notifications (user_id, type, title, body, data)
  select
    p.id,
    'class_alert',
    coalesce(nullif(btrim(new.title), ''), new.course_code || ' class alert'),
    concat_ws(
      ' · ',
      nullif(btrim(new.description), ''),
      case
        when new.alert_time is not null then to_char(new.alert_time at time zone 'Africa/Lagos', 'ddd, DD Mon YYYY HH24:MI')
        else null
      end
    ),
    jsonb_build_object(
      'class_alert_id', new.id,
      'course_code', new.course_code,
      'alert_time', new.alert_time,
      'materials_needed', coalesce(new.materials_needed, '[]'::jsonb),
      'university', new.university
    )
  from public.profiles p
  where p.university = new.university
    and p.id is distinct from new.created_by;

  return new;
end;
$$;

drop trigger if exists class_alert_notification on public.class_alerts;
create trigger class_alert_notification
after insert on public.class_alerts
for each row execute procedure public.notify_class_alert_created();

revoke execute on function public.notify_class_alert_created() from public, anon, authenticated;
grant execute on function public.notify_class_alert_created() to service_role;
