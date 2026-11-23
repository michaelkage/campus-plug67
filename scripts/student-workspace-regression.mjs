import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const home = read('src/pages/Home.jsx')
const hook = read('src/features/workspace/useStudentWorkspace.ts')
const model = read('src/features/workspace/workspaceModel.ts')
const keys = read('src/lib/queryKeys.ts')
const tests = read('src/features/workspace/workspaceModel.test.ts')

for (const value of [
  'useStudentWorkspace(user?.id)',
  'buildWorkspaceActions',
  'Your recent transactions',
  'Things needing your attention',
  'Unread messages',
  'Unread alerts',
  'Your campus workspace',
  'Verify your campus identity',
]) {
  if (!home.includes(value)) throw new Error(`Student dashboard is missing: ${value}`)
}
for (const value of [
  "from('transactions')", "from('gig_bookings')", "from('gear_rentals')", 'activeTransactions',
  "from('listings')", "from('notifications')", "from('messages')", "from('profiles')",
  "not('escrow_status','in','(\"released\",\"refunded\")')", 'walletBalanceKobo', 'plugScore',
  'refetchInterval: 30_000', 'refetchOnWindowFocus: true',
  'pendingSalesCount', 'pendingPurchasesCount',
]) {
  if (!hook.includes(value)) throw new Error(`Workspace data contract is missing: ${value}`)
}
for (const value of [
  'Dispute needs attention', 'Inspect item and respond',
  'Review delivered service', 'Verify returned item',
  'Transaction completed, settlement still pending',
  "['released', 'refunded']",
]) {
  if (!model.includes(value)) throw new Error(`Workspace action model is missing: ${value}`)
}
if (!keys.includes("overview: (userId: string) => ['workspace', 'overview', userId]")) {
  throw new Error('Workspace query key must be owner-scoped')
}
if (!tests.includes('does not treat legacy completed status as proof that escrow was paid')) {
  throw new Error('Workspace regression suite must guard legacy completed-vs-released semantics')
}
if (home.includes("from('transactions').select('id', { count: 'exact', head: true }).eq('status', 'released')")) {
  throw new Error('Student dashboard must not display global platform transaction counts as personal stats')
}
console.log('Student workspace regression checks passed.')
