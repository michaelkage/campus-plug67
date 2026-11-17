-- Campus Plug — PostgREST schema cache refresh
-- Keep the API schema synchronized after migrations that add/rename columns,
-- constraints, triggers, and relationships used by the frontend.
NOTIFY pgrst, 'reload schema';
