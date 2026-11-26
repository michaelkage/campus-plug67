BEGIN;
SELECT plan(7);

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

SELECT set_config(
  'request.jwt.claims',
  '{"role":"authenticated","app_metadata":{"role":"platform_admin"}}',
  true
);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);

SELECT ok(
  public.get_admin_financial_operations_snapshot(30) ? 'generated_at',
  'Platform admins can read the financial operations snapshot'
);
SELECT is(
  jsonb_typeof(public.get_admin_financial_operations_snapshot(30)->'payout_attention'),
  'array',
  'Payout attention queue is returned as a bounded array'
);
SELECT is(
  jsonb_typeof(public.get_admin_financial_operations_snapshot(30)->'payout_operator_audit'),
  'array',
  'Operator audit history is returned as a bounded array'
);
SELECT throws_ok(
  $$ SELECT public.get_admin_financial_operations_snapshot(101) $$,
  'P0001',
  'Limit must be between 1 and 100',
  'Snapshot rejects unbounded result limits'
);

SELECT * FROM finish();
ROLLBACK;
