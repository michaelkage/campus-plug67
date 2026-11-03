import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [chat, inbox] = await Promise.all([
  readFile(new URL('../src/components/chat/MarketplaceChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Chat.jsx', import.meta.url), 'utf8'),
])

assert.match(chat, /conversationQuery\.eq\('transaction_id', transactionId\)\s*:\s*conversationQuery\.is\('transaction_id', null\)/)
assert.match(chat, /verifyQuery\.eq\('transaction_id', transactionId\)\s*:\s*verifyQuery\.is\('transaction_id', null\)/)
assert.match(chat, /\(newMsg\.transaction_id \?\? null\) === \(transactionId \?\? null\)/)
assert.match(chat, /chat:\$\\{transactionId \\?\\? 'general'\\}/)
assert.match(chat, /remainingUnread\?\.length/)

assert.match(inbox, /const conversationKey = `\$\{otherId\}:\$\{message\.transaction_id \?\? 'general'\}`/)
assert.match(inbox, /key=\{\`\$\{otherId\}:\$\{transactionId \?\? 'general'\}\`\}/)
assert.match(inbox, /[?]tx=\$\{encodeURIComponent\(transactionId\)\}/)

console.log('Chat transaction scoping and read-receipt regression checks passed.')
