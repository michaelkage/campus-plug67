-- Restrict SECURITY DEFINER RPCs to their actual trust boundary.
--
-- SECURITY DEFINER bypasses table RLS. These grants are part of the API
-- contract, not a harmless lint setting. Keep browser-callable functions
-- narrowly scoped and move worker-only operations behind service_role.

-- These functions are called only by trusted Edge Functions using the
-- service-role client. In particular, atomic_pool_join accepts a user id and
-- payment reference, so it must never be directly callable by a browser.
REVOKE ALL ON FUNCTION public.atomic_pool_join(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_pool_join(uuid, uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.consume_session_handoff(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_session_handoff(text)
  TO service_role;

REVOKE ALL ON FUNCTION public.expire_flash_deals()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_flash_deals()
  TO service_role;

REVOKE ALL ON FUNCTION public.increment_view_count(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_view_count(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.update_streak(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_streak(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION public.update_juror_accuracy(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_juror_accuracy(uuid)
  TO service_role;

-- Legacy / internal helpers have no browser callers in the repository.
-- Some accept arbitrary user, case, transaction, or listing identifiers.
REVOKE ALL ON FUNCTION public.assign_jurors(uuid, integer, uuid[])
  FROM PUBLIC, anon, authenticated, service_role;

-- These two legacy functions exist in production but are absent from the
-- tracked migration chain. Guard them so a clean database reset stays valid.
DO $
BEGIN
  IF to_regprocedure('public.delete_user_data(uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.delete_user_data(uuid) FROM PUBLIC, anon, authenticated, service_role';
  END IF;

  IF to_regprocedure('public.export_user_data(uuid)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.export_user_data(uuid) FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END;
$;

REVOKE ALL ON FUNCTION public.search_users_by_department(text)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_priority_relist(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.scan_listing_trust(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- This legacy trigger function is not attached to a production trigger.
-- Keep it unavailable to API roles until it is deliberately retired or wired.
REVOKE ALL ON FUNCTION public.reconcile_student_escrow()
  FROM PUBLIC, anon, authenticated, service_role;

-- Browser eligibility checks are intentionally retained, but are now bound
-- to the authenticated transaction participant and the relevant party role.
CREATE OR REPLACE FUNCTION public.check_ghost_refund(p_transaction_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor uuid := auth.uid();
  tx public.transactions%ROWTYPE;
  eligible boolean := false;
  reason text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT *
    INTO tx
    FROM public.transactions
   WHERE id = p_transaction_id
     AND (buyer_id = actor OR seller_id = actor);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found or not authorized';
  END IF;

  -- Only the buyer can request a ghost refund. The seller may still render
  -- this component, so return a non-eligible result rather than an exception.
  IF tx.buyer_id <> actor THEN
    RETURN json_build_object(
      'eligible', false,
      'reason', 'buyer_only',
      'transaction_id', tx.id
    );
  END IF;

  IF tx.buyer_arrived AND (
    NOT tx.seller_arrived AND (
      NOT tx.omw_active OR
      (tx.omw_active AND tx.movement_delta_m < 50
        AND tx.omw_timestamp < now() - interval '20 minutes')
    )
  ) THEN
    eligible := true;
    reason := 'Seller failed to arrive or show meaningful movement';
  END IF;

  RETURN json_build_object(
    'eligible', eligible,
    'reason', reason,
    'transaction_id', tx.id
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_ghost_refund(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_ghost_refund(uuid)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.check_priority_relist_v2(p_transaction_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  actor uuid := auth.uid();
  tx public.transactions%ROWTYPE;
  seller_prof public.profiles%ROWTYPE;
  recent_hist integer;
  deny_reason text;
BEGIN
  IF actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT *
    INTO tx
    FROM public.transactions
   WHERE id = p_transaction_id
     AND (buyer_id = actor OR seller_id = actor);

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found or not authorized';
  END IF;

  -- Priority relisting is a seller-only action.
  IF tx.seller_id <> actor THEN
    RETURN json_build_object('eligible', false, 'reason', 'seller_only');
  END IF;

  SELECT *
    INTO seller_prof
    FROM public.profiles
   WHERE id = actor;

  IF seller_prof.last_boost_at IS NOT NULL
     AND seller_prof.last_boost_at > now() - interval '6 hours'
  THEN
    deny_reason := 'cooldown_active';
    RETURN json_build_object(
      'eligible', false,
      'reason', deny_reason,
      'cooldown_remaining_mins',
      round(extract(epoch FROM (
        seller_prof.last_boost_at + interval '6 hours' - now()
      )) / 60)
    );
  END IF;

  IF seller_prof.priority_relist_today >= 1 THEN
    RETURN json_build_object('eligible', false, 'reason', 'daily_limit_reached');
  END IF;

  IF seller_prof.priority_relist_this_week >= 3 THEN
    RETURN json_build_object('eligible', false, 'reason', 'weekly_limit_reached');
  END IF;

  SELECT count(*)
    INTO recent_hist
    FROM public.transactions t
   WHERE t.seller_id = tx.seller_id
     AND t.buyer_id = tx.buyer_id
     AND t.created_at > now() - interval '30 days'
     AND t.id <> p_transaction_id
     AND t.status NOT IN ('cancelled');

  IF recent_hist > 0 THEN
    RETURN json_build_object(
      'eligible', false,
      'reason', 'buyer_seller_recent_history',
      'detail', 'This buyer has transacted with you recently. Boost denied to prevent abuse.'
    );
  END IF;

  IF NOT tx.seller_arrived
     OR tx.seller_arrived_at IS NULL
     OR tx.seller_arrived_at > now() - interval '15 minutes'
  THEN
    RETURN json_build_object('eligible', false, 'reason', 'seller_not_present_long_enough');
  END IF;

  IF tx.buyer_arrived THEN
    RETURN json_build_object('eligible', false, 'reason', 'buyer_arrived');
  END IF;

  RETURN json_build_object('eligible', true, 'reason', null);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.check_priority_relist_v2(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_priority_relist_v2(uuid)
  TO authenticated;

-- The installed PostGIS package may restore these extension function ACLs
-- during extension maintenance. Re-assert the existing API boundary.
DO $$
BEGIN
  IF to_regprocedure('public.st_estimatedextent(text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text,text) FROM PUBLIC, anon, authenticated';
  END IF;

  IF to_regprocedure('public.st_estimatedextent(text,text,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text,text,text) FROM PUBLIC, anon, authenticated';
  END IF;

  IF to_regprocedure('public.st_estimatedextent(text,text,text,boolean)') IS NOT NULL THEN
    EXECUTE 'REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text,text,text,boolean) FROM PUBLIC, anon, authenticated';
  END IF;
END;
$$;

-- Trigger functions are not Data API RPCs. PostgreSQL requires EXECUTE when a
-- trigger is created; existing triggers execute in the triggering statement's
-- context (or as the function owner for SECURITY DEFINER triggers). Remove
-- direct client EXECUTE without dropping or changing any trigger.
DO $$
DECLARE
  trigger_function record;
BEGIN
  FOR trigger_function IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prosecdef
       AND p.prorettype = 'trigger'::regtype
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',
      trigger_function.oid::regprocedure
    );
  END LOOP;
END;
$$;
