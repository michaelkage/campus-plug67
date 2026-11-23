-- Make read receipts a durable boolean and expose one row per conversation
-- with exact unread counts. RLS remains the visibility boundary.
BEGIN;

ALTER TABLE public.messages DISABLE TRIGGER messages_guard_immutable;
UPDATE public.messages SET read = false WHERE read IS NULL;
ALTER TABLE public.messages
  ALTER COLUMN read SET DEFAULT false,
  ALTER COLUMN read SET NOT NULL;
ALTER TABLE public.messages ENABLE TRIGGER messages_guard_immutable;

CREATE INDEX IF NOT EXISTS messages_unread_recipient_conversation_idx
  ON public.messages(receiver_id, transaction_id, created_at DESC, id DESC)
  WHERE read = false;

CREATE OR REPLACE FUNCTION public.get_chat_inbox()
RETURNS TABLE (
  other_user_id uuid,
  transaction_id uuid,
  last_message_id uuid,
  last_sender_id uuid,
  last_receiver_id uuid,
  last_content text,
  last_body text,
  last_created_at timestamptz,
  last_read boolean,
  unread_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  WITH scoped_messages AS (
    SELECT
      m.id,
      m.sender_id,
      m.receiver_id,
      m.transaction_id,
      m.content,
      m.body,
      m.created_at,
      m.read,
      CASE WHEN m.sender_id = auth.uid() THEN m.receiver_id ELSE m.sender_id END AS other_user_id
    FROM public.messages m
    WHERE auth.uid() IS NOT NULL
      AND (m.sender_id = auth.uid() OR m.receiver_id = auth.uid())
  ),
  latest_messages AS (
    SELECT DISTINCT ON (sm.other_user_id, sm.transaction_id)
      sm.other_user_id,
      sm.transaction_id,
      sm.id,
      sm.sender_id,
      sm.receiver_id,
      sm.content,
      sm.body,
      sm.created_at,
      sm.read
    FROM scoped_messages sm
    ORDER BY sm.other_user_id, sm.transaction_id, sm.created_at DESC, sm.id DESC
  ),
  unread_messages AS (
    SELECT sm.other_user_id, sm.transaction_id, count(*)::bigint AS unread_count
    FROM scoped_messages sm
    WHERE sm.receiver_id = auth.uid() AND sm.read = false
    GROUP BY sm.other_user_id, sm.transaction_id
  )
  SELECT
    lm.other_user_id,
    lm.transaction_id,
    lm.id AS last_message_id,
    lm.sender_id AS last_sender_id,
    lm.receiver_id AS last_receiver_id,
    lm.content AS last_content,
    lm.body AS last_body,
    lm.created_at AS last_created_at,
    lm.read AS last_read,
    COALESCE(um.unread_count, 0)::bigint AS unread_count
  FROM latest_messages lm
  LEFT JOIN unread_messages um
    ON um.other_user_id = lm.other_user_id
   AND um.transaction_id IS NOT DISTINCT FROM lm.transaction_id
  ORDER BY lm.created_at DESC, lm.id DESC;
$function$;

REVOKE ALL ON FUNCTION public.get_chat_inbox() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_chat_inbox() TO authenticated;

COMMIT;
