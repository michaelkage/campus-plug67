-- Campus Plug v6.9 follow-up: legacy state normalization + location retention.

-- Older builds used `completed`; the canonical transaction state is `released`.
-- Disable the notification/business trigger while normalizing historical rows so
-- old completed transactions are not treated as brand-new sales.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.transactions WHERE status='completed') THEN
    ALTER TABLE public.transactions DISABLE TRIGGER on_transaction_updated;
    UPDATE public.transactions
    SET status='released',
        escrow_status='released',
        released_at=COALESCE(released_at,updated_at,created_at,now()),
        completed_at=COALESCE(completed_at,updated_at,created_at,now())
    WHERE status='completed';
    ALTER TABLE public.transactions ENABLE TRIGGER on_transaction_updated;
  END IF;
END $$;

-- Location data is a risk signal, not permanent history. Keep the current beacon
-- for only 24h and detailed beacon/proximity history for 7d.
CREATE OR REPLACE FUNCTION public.cleanup_beacon_history(p_history_days integer DEFAULT 7)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public
AS $$
DECLARE removed bigint;
BEGIN
  IF p_history_days < 1 OR p_history_days > 30 THEN
    RAISE EXCEPTION 'Retention window must be between 1 and 30 days';
  END IF;

  DELETE FROM public.ticker_events
  WHERE event_type IN ('beacon_current','beacon_update','proximity_check')
    AND created_at < CASE
      WHEN event_type='beacon_current' THEN now() - interval '24 hours'
      ELSE now() - make_interval(days => p_history_days)
    END;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;
REVOKE ALL ON FUNCTION public.cleanup_beacon_history(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_beacon_history(integer) TO service_role;

COMMENT ON FUNCTION public.cleanup_beacon_history(integer) IS
  'Service-only retention job: removes stale current beacons after 24h and detailed location history after the configured number of days.';
