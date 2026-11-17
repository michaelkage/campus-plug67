-- Pin the trigger function to an empty search_path.
-- All application objects referenced by the function are schema-qualified.
-- pg_catalog remains implicitly available for built-ins such as now().

ALTER FUNCTION public.touch_group_chat_activity()
  SET search_path = '';
