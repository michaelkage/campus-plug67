-- Durable notification read state and fast recipient-scoped unread counts.
UPDATE public.notifications SET read = false WHERE read IS NULL;
ALTER TABLE public.notifications
  ALTER COLUMN read SET DEFAULT false,
  ALTER COLUMN read SET NOT NULL;

CREATE INDEX IF NOT EXISTS notifications_unread_user_idx
  ON public.notifications(user_id, created_at DESC, id DESC)
  WHERE read = false;

CREATE INDEX IF NOT EXISTS notifications_user_created_idx
  ON public.notifications(user_id, created_at DESC, id DESC);
