BEGIN;

SELECT plan(3);

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('f4000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'chat-read-sender@test.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('f4000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'chat-read-receiver@test.invalid', '', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

INSERT INTO public.messages (
  id, sender_id, receiver_id, body, content, message_type, read
) VALUES (
  'f5000000-0000-4000-8000-000000000001',
  'f4000000-0000-4000-8000-000000000001',
  'f4000000-0000-4000-8000-000000000002',
  'Read receipt regression fixture',
  'Read receipt regression fixture',
  'text',
  false
);

-- Exercise the same authenticated RLS and trigger path used by the chat client.
SET LOCAL ROLE authenticated;

-- The sender must be rejected while the fixture is still unread. Testing this
-- after the receiver update would only exercise an unchanged false->true value
-- and would never enter the trigger's read-receipt authorization branch.
SELECT set_config('request.jwt.claim.sub', 'f4000000-0000-4000-8000-000000000001', true);

SELECT throws_ok(
  $$
    UPDATE public.messages
       SET read = true
     WHERE id = 'f5000000-0000-4000-8000-000000000001'
  $$,
  'P0001',
  'messages: only the receiver can mark an unread message as read',
  'The sender cannot forge a read receipt for an outgoing unread message'
);

-- The legitimate receiver can then persist the same unread->read transition.
SELECT set_config('request.jwt.claim.sub', 'f4000000-0000-4000-8000-000000000002', true);

SELECT lives_ok(
  $$
    UPDATE public.messages
       SET read = true
     WHERE id = 'f5000000-0000-4000-8000-000000000001'
       AND receiver_id = auth.uid()
       AND read = false
  $$,
  'The receiving participant can persist an unread message as read'
);

SELECT is(
  (
    SELECT read
      FROM public.messages
     WHERE id = 'f5000000-0000-4000-8000-000000000001'
  ),
  true,
  'The read receipt is visible as persisted state to the receiver'
);

SELECT * FROM finish();
ROLLBACK;
