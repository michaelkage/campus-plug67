BEGIN;
SELECT plan(3);

SELECT set_config('request.jwt.claims', '{"role":"authenticated"}', true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SELECT throws_ok(
  $$ SELECT public.get_admin_financial_operations_snapshot(30) $$,
  'P0001',
  'Platform admin required',
  'Non-admin sessions cannot read financial operations'
);
SELECT is(
  has_function_privilege('anon', 'public.get_admin_financial_operations_snapshot(integer)', 'EXECUTE'),
  false,
  'Anonymous users cannot execute the financial operations snapshot'
);
SELECT is(
  has_function_privilege('authenticated', 'public.get_admin_financial_operations_snapshot(integer)', 'EXECUTE'),
  true,
  'Authenticated users can reach the RPC but remain subject to its server-side admin check'
);

SELECT * FROM finish();
ROLLBACK;
