import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [chat, inbox] = await Promise.all([
  readFile(new URL('../src/components/chat/MarketplaceChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/Chat.jsx', import.meta.url), 'utf8'),
])

assert.match(chat, /transactionId/)
assert.match(chat, /transactionId/)
assert.match(chat, /transactionId/)
assert.match(chat, /transactionId/)
assert.match(chat, /remainingUnread\?\.length/)

assert.match(inbox, /const conversationKey = `\$\{otherId\}:\$\{message\.transaction_id \?\? 'general'\}`/)
assert.match(inbox, /key=\{\`\$\{otherId\}:\$\{transactionId \?\? 'general'\}\`\}/)
assert.match(inbox, /[?]tx=\$\{encodeURIComponent\(transactionId\)\}/)

console.log('Chat transaction scoping and read-receipt regression checks passed.')
