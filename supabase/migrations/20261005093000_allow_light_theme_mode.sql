-- Widen profiles.theme_mode to accept 'light'.
--
-- The Material 3 theme engine derives a full tonal palette per mode, so light
-- mode is a first-class option. The original constraint (009_v67_integration.sql)
-- allowed only ('dark','amoled'), which made the light palette impossible to
-- persist. Existing rows are unaffected; the column default stays 'dark'.
--
-- Idempotent: re-running drops and recreates the named constraint.

alter table public.profiles
  drop constraint if exists profiles_theme_mode_check;

alter table public.profiles
  add constraint profiles_theme_mode_check
  check (theme_mode is null or theme_mode in ('light','dark','amoled'));

comment on column public.profiles.theme_mode is
  'User-selected Material 3 appearance: light, dark, or amoled. Null means follow the OS via prefers-color-scheme.';