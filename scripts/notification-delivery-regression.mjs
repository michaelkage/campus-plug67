import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [page, topNav, realtime, migration] = await Promise.all([
  readFile(new URL('../src/pages/Notifications.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/layout/TopNav.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/hooks/useRealtime.js', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261123180000_notification_read_state_indexes.sql', import.meta.url), 'utf8'),
])

assert.ok(page.includes("queryKey: ['unread-notifications', user?.id]"), 'Notification page must use a shared unread query key')
assert.ok(page.includes(".select('id', { count: 'exact', head: true })"), 'Notification page unread count must be exact')
assert.ok(page.includes('if (error) throw error'), 'Notification list errors must not be silently treated as an empty inbox')
assert.ok(page.includes('remainingUnread ?? 0') && page.includes('verifyError'), 'Mark-all-read must verify persisted state after RLS updates')
assert.ok(page.includes(".select('id')\n      .maybeSingle()"), 'Single notification read must verify that a row was updated')
assert.ok(page.includes("select('read')"), 'Concurrent read updates must be verified before navigation')
assert.ok(page.includes('onUpdate: (updated)'), 'Notification read-state updates must reconcile the inbox cache')
assert.ok(page.includes("qc.invalidateQueries({ queryKey: ['unread-notifications', user?.id] })"), 'Notification mutations must refresh the global unread count')

assert.ok(topNav.includes(".select('id',{count:'exact',head:true})"), 'Top navigation must use an exact unread count')
assert.ok(topNav.includes("table:'notifications'"), 'Top navigation must subscribe to notification changes')
assert.ok(topNav.includes("queryClient.invalidateQueries({queryKey:['unread-notifications',user.id]})"), 'Realtime notifications must refresh the global badge')

assert.ok(realtime.includes('onUpdate,enabled:!!userId,batchMs'), 'Notification realtime hook must forward update events')
assert.ok(migration.includes('ALTER COLUMN read SET NOT NULL'), 'Notification read state must not be nullable')
assert.ok(migration.includes('notifications_unread_user_idx'), 'Unread notification count must use a partial index')
assert.ok(migration.includes('notifications_user_created_idx'), 'Notification inbox must use a recipient timeline index')

console.log('Notification exact-count, realtime and persisted-read regression checks passed.')
