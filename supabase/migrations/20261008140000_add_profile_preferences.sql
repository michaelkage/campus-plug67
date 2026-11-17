-- Store non-sensitive UI preferences with the authenticated profile.
alter table public.profiles
  add column if not exists preferences jsonb not null default '{}'::jsonb;

comment on column public.profiles.preferences is
  'Non-sensitive UI/accessibility/notification preferences. Never store credentials, tokens, or secrets here.';