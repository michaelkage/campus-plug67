-- Restore participant-scoped message updates without granting broad row mutation.
-- The inbox currently has SELECT/INSERT policies only, so read-receipt UPDATEs
-- are silently filtered by RLS even though authenticated has table privileges.

BEGIN;

REVOKE UPDATE ON TABLE public.messages FROM authenticated;
GRANT UPDATE (read, content) ON TABLE public.messages TO authenticated;

DROP POLICY IF EXISTS "Participants update messages" ON public.messages;
CREATE POLICY "Participants update messages"
  ON public.messages
  FOR UPDATE
  TO authenticated
  USING (
    (SELECT auth.uid()) = sender_id
    OR (SELECT auth.uid()) = receiver_id
  )
  WITH CHECK (
    (SELECT auth.uid()) = sender_id
    OR (SELECT auth.uid()) = receiver_id
  );

-- A receiver may only move their own incoming message from unread to read.
-- A sender may edit their own non-system message for 60 seconds or soft-delete
-- it. The trigger keeps legacy body and current content columns synchronized.
CREATE OR REPLACE FUNCTION public.messages_guard_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $function$
DECLARE
  actor_id uuid := (SELECT auth.uid());
BEGIN
  IF OLD.sender_id IS DISTINCT FROM NEW.sender_id
    OR OLD.receiver_id IS DISTINCT FROM NEW.receiver_id
    OR OLD.listing_id IS DISTINCT FROM NEW.listing_id
    OR OLD.transaction_id IS DISTINCT FROM NEW.transaction_id
    OR OLD.id IS DISTINCT FROM NEW.id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  THEN
    RAISE EXCEPTION 'messages: participants and message linkage are immutable';
  END IF;

  IF OLD.read IS DISTINCT FROM NEW.read THEN
    IF actor_id IS DISTINCT FROM OLD.receiver_id
      OR OLD.read IS DISTINCT FROM false
      OR NEW.read IS DISTINCT FROM true
    THEN
      RAISE EXCEPTION 'messages: only the receiver can mark an unread message as read';
    END IF;
  END IF;

  IF OLD.content IS DISTINCT FROM NEW.content
    OR OLD.body IS DISTINCT FROM NEW.body
  THEN
    IF actor_id IS DISTINCT FROM OLD.sender_id
      OR COALESCE(OLD.is_system_msg, false)
      OR OLD.deleted_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'messages: only the sender can edit or delete their own message';
    END IF;

    IF NEW.content = '[Message deleted]' THEN
      NEW.content := '[Message deleted]';
      NEW.body := '[Message deleted]';
      NEW.deleted_at := COALESCE(OLD.deleted_at, now());
    ELSIF now() <= OLD.created_at + interval '60 seconds'
      AND NULLIF(BTRIM(NEW.content), '') IS NOT NULL
    THEN
      NEW.body := NEW.content;
    ELSE
      RAISE EXCEPTION 'messages: edits are limited to 60 seconds after sending';
    END IF;
  END IF;

  IF OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
    AND NOT (
      actor_id = OLD.sender_id
      AND OLD.deleted_at IS NULL
      AND NEW.deleted_at IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'messages: deletion metadata is immutable';
  END IF;

  RETURN NEW;
END;
$function$;

COMMIT;
