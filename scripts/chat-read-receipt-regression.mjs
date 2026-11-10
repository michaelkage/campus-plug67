import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [chat, inbox] = await Promise.all([
  readFile(new URL('../src/components/chat/MarketplaceChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Chat.jsx', import.meta.url), 'utf8'),
])

assert.ok(chat.includes("conversationQuery.eq('transaction_id', transactionId) : conversationQuery.is('transaction_id', null)"))
assert.ok(chat.includes("verifyQuery.eq('transaction_id', transactionId) : verifyQuery.is('transaction_id', null)"))
assert.ok(chat.includes('(newMsg.transaction_id ?? null) === (transactionId ?? null)'))
assert.ok(chat.includes("transactionId ?? 'general'"))
assert.ok(chat.includes('remainingUnread?.length'))
assert.ok(chat.includes(".subscribe(status =>"))
assert.ok(chat.includes("if (status === 'SUBSCRIBED') void markMessagesAsRead()"))

assert.ok(inbox.includes('const conversationKey ='))
assert.ok(inbox.includes("message.transaction_id ?? 'general'"))
assert.ok(inbox.includes("transactionId ?? 'general'"))
assert.ok(inbox.includes('encodeURIComponent(transactionId)'))

console.log('Chat transaction scoping and read-receipt regression checks passed.')