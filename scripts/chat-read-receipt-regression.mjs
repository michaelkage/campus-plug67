import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [chat, inbox, topNav, migration] = await Promise.all([
  readFile(new URL('../src/components/chat/MarketplaceChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Chat.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/layout/TopNav.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261123170000_chat_inbox_read_receipt_consistency.sql', import.meta.url), 'utf8'),
])

assert.ok(chat.includes("conversationQuery.eq('transaction_id', transactionId) : conversationQuery.is('transaction_id', null)"))
assert.ok(chat.includes("verifyQuery.eq('transaction_id', transactionId) : verifyQuery.is('transaction_id', null)"))
assert.ok(chat.includes('(newMsg.transaction_id ?? null) === (transactionId ?? null)'))
assert.ok(chat.includes("transactionId ?? 'general'"))
assert.ok(chat.includes('remainingUnread?.length'))
assert.ok(chat.includes("qc.invalidateQueries({ queryKey: ['unread-messages', currentUserId] })"), 'Read-receipt updates must invalidate the unread badge')
assert.ok(chat.includes("qc.invalidateQueries({ queryKey: ['chat-inbox', currentUserId] })"), 'Read-receipt updates must invalidate inbox summaries')

assert.ok(inbox.includes("supabase.rpc('get_chat_inbox')"), 'Inbox must use the exact server-side summary RPC')
assert.ok(inbox.includes('row.unread_count'), 'Conversation unread counts must use exact server aggregates')
assert.ok(inbox.includes("transactionId ?? 'general'"))
assert.ok(inbox.includes('encodeURIComponent(transactionId)'))
assert.ok(!inbox.includes('.limit(500)'), 'Inbox unread counts must not be truncated by a client-side message cap')

assert.ok(topNav.includes(".select('id',{count:'exact',head:true})"), 'Top navigation must use an exact count rather than fetching message IDs')
assert.ok(topNav.includes("table:'messages'"), 'Top navigation unread count must subscribe to message changes')
assert.ok(topNav.includes("queryClient.invalidateQueries({queryKey:['unread-messages',user.id]})"), 'Realtime read receipts must refresh the unread badge')

assert.ok(migration.includes('ALTER COLUMN read SET NOT NULL'), 'Read receipt state must not be nullable')
assert.ok(migration.includes('messages_unread_recipient_conversation_idx'), 'Unread counts must use a partial recipient index')
assert.ok(migration.includes('CREATE OR REPLACE FUNCTION public.get_chat_inbox()'), 'Inbox summary RPC must exist')
assert.ok(migration.includes('SECURITY INVOKER'), 'Inbox summaries must preserve caller RLS')
assert.ok(migration.includes('count(*)::bigint AS unread_count'), 'Unread counts must be exact per conversation')
assert.ok(migration.includes('REVOKE ALL ON FUNCTION public.get_chat_inbox() FROM PUBLIC, anon'), 'Inbox RPC must not be public')
assert.ok(migration.includes('GRANT EXECUTE ON FUNCTION public.get_chat_inbox() TO authenticated'))

console.log('Chat transaction scoping, exact inbox counts and realtime read-receipt regression checks passed.')
