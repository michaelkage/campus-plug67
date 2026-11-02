import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => { throw new Error(message); };
const assertIncludes = (source, text, message) => {
  if (!source.includes(text)) fail(message || `Missing chat integrity guard: ${text}`);
};

const migration = read('supabase/migrations/20261102134500_fix_message_read_receipts.sql');
const chat = read('src/components/chat/MarketplaceChat.tsx');
const inbox = read('src/pages/Chat.jsx');

assertIncludes(migration, 'REVOKE UPDATE ON TABLE public.messages FROM authenticated',
  'Authenticated message updates must be narrowed before read-receipt access is granted');
assertIncludes(migration, 'GRANT UPDATE (read, content) ON TABLE public.messages TO authenticated',
  'Authenticated users may only update read receipts and message content');
assertIncludes(migration, 'CREATE POLICY "Participants update messages"',
  'Only conversation participants may update their message rows');
assertIncludes(migration, '(SELECT auth.uid()) = receiver_id',
  'RLS must scope message updates to a conversation participant');
assertIncludes(migration, 'OLD.read IS DISTINCT FROM false',
  'Read receipts must be one-way from unread to read');
assertIncludes(migration, 'actor_id IS DISTINCT FROM OLD.receiver_id',
  'Only the receiver may mark a message as read');
assertIncludes(migration, 'OLD.created_at + interval \'60 seconds\'',
  'Message edits must retain the existing 60-second edit window');
assertIncludes(migration, "NEW.content = '[Message deleted]'",
  'Sender soft-delete must remain supported');
assertIncludes(migration, 'NEW.body := NEW.content',
  'Legacy body and current content columns must stay synchronized');

assertIncludes(chat, ".update({ read: true })",
  'Conversation view must persist incoming read receipts');
assertIncludes(chat, "select('id')",
  'Read-receipt updates must verify their affected rows');
assertIncludes(chat, "['chat-inbox', currentUserId]",
  'Read receipts must invalidate the actual inbox query key');
assertIncludes(chat, 'remainingUnread',
  'Client must detect RLS-filtered or otherwise unsuccessful read updates');
assertIncludes(chat, "update({ content: newContent })",
  'Sender edit UI must continue to use the guarded content update');
assertIncludes(chat, "update({ content: '[Message deleted]' })",
  'Sender soft-delete UI must continue to use the guarded placeholder');

assertIncludes(inbox, "message.receiver_id === user?.id && !message.read",
  'Inbox unread counts must remain scoped to incoming messages');

console.log('Chat read-receipt regression checks passed (static SQL/client invariants).');
