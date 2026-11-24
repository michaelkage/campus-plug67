import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const fail = (message) => { throw new Error(message) }

const css = read('src/styles/accessibility.css')
const index = read('src/index.css')
const layout = read('src/components/layout/Layout.jsx')
const tokens = JSON.parse(read('src/theme/theme.tokens.json'))
const app = read('src/App.tsx')
const notifications = read('src/pages/Notifications.jsx')
const notificationToast = read('src/components/ui/NotificationBanner.jsx')
const settings = read('src/pages/Settings.jsx')
const serviceBookingActions = read('src/components/services/ServiceBookingActions.jsx')
const authPage = read('src/pages/Auth.jsx')
const listingDetail = read('src/pages/ListingDetail.jsx')
const offlineBanner = read('src/components/ui/OfflineSyncBanner.tsx')

for (const required of [
  '--cp-control-min-height',
  '--cp-focus-width',
  ':focus-visible',
  '[aria-invalid="true"]',
  '.cp-skip-link',
  '.cp-field-error',
  '@media (prefers-reduced-motion: reduce)',
  '@media (forced-colors: active)',
]) {
  if (!css.includes(required)) fail(`Accessibility foundation missing: ${required}`)
}

if (!index.includes("@import './styles/accessibility.css';")) {
  fail('Accessibility stylesheet must be loaded by the global design system')
}
if (!layout.includes('href="#main-content"') || !layout.includes('id="main-content"')) {
  fail('Authenticated layout must expose a working skip-to-content link')
}
if (!layout.includes('useReducedMotion()') || !layout.includes('reduceMotion ? false')) {
  fail('Route transitions must respect the user reduced-motion preference')
}
if (!app.includes('<Layout/>')) fail('Accessibility layout regression must run against the app shell')
if (/<main\b/.test(settings)) fail('Settings page must not create a nested main landmark inside the authenticated layout')
if (!settings.includes("aria-pressed={theme==='dark'}") || !settings.includes("aria-pressed={theme==='amoled'}")) fail('Theme controls must expose their selected state with aria-pressed')
if (!settings.includes('aria-live="polite"') || !settings.includes('role="status"') || !settings.includes('{saveAnnouncement}')) fail('Preference save state must be announced only when an actual save state changes')
if (!settings.includes("setSaveAnnouncement('Saving preferences')") || !settings.includes("setSaveAnnouncement('Preferences saved')") || !settings.includes("setSaveAnnouncement('Unable to save preferences')")) fail('Preference save announcements must cover pending, success and failure states')
if (!settings.includes('saveQueueRef') || !settings.includes('prefsRef.current')) fail('Preference writes must serialize and use the latest optimistic preference snapshot')
if (!serviceBookingActions.includes('aria-describedby={`service-quote-scope-help-${booking.id}`}') || !serviceBookingActions.includes('id={`service-quote-scope-help-${booking.id}`}')) fail('Service quote scope guidance must be programmatically associated with its field')
if (!serviceBookingActions.includes('aria-describedby={`service-dispute-help-${booking.id}`}') || !serviceBookingActions.includes('id={`service-dispute-help-${booking.id}`}')) fail('Service dispute guidance must be programmatically associated with its field')
if (!serviceBookingActions.includes('<form onSubmit={sendQuote} aria-busy={busy}') || !serviceBookingActions.includes('<form onSubmit={openDispute} aria-busy={busy}')) fail('Service quote and dispute submissions must expose pending state')
if (!serviceBookingActions.includes('quoteTriggerRef.current?.focus()') || !serviceBookingActions.includes('disputeTriggerRef.current?.focus()') || !serviceBookingActions.includes('quoteFieldRef.current?.focus()') || !serviceBookingActions.includes('disputeFieldRef.current?.focus()')) fail('Opening service inline forms must move focus into the form and restore it to the trigger when closed')
if (!serviceBookingActions.includes('aria-expanded={showQuoteForm}') || !serviceBookingActions.includes('aria-expanded={showDisputeForm}')) fail('Service inline form triggers must expose their expanded state')
if (!authPage.includes('role={formError ? \'alert\' : \'status\'}') || !authPage.includes('aria-live={formError ? \'assertive\' : \'polite\'}')) fail('Authentication outcomes must be announced accessibly')
if (!authPage.includes('aria-busy={submitting}') || !authPage.includes('aria-pressed={showPass}')) fail('Authentication form and password visibility state must be exposed to assistive technology')
if (!authPage.includes('useReducedMotion()') || !authPage.includes('prefersReducedMotion ? 0 : 0.3') || !authPage.includes('prefersReducedMotion ? 0 : 0.2')) fail('Authentication transitions must respect reduced-motion preferences')
if (!listingDetail.includes('transaction-dispute-help-') || !listingDetail.includes('aria-describedby={`transaction-dispute-help-${tx.id}`}')) fail('Escrow dispute reason fields must expose their minimum-length guidance')
if (!listingDetail.includes('disputeFieldRef.current?.focus()') || !listingDetail.includes('disputeTriggerRef.current?.focus()') || !listingDetail.includes('aria-expanded={showDispute}')) fail('Escrow dispute forms must manage focus and expose expanded state')
if (!listingDetail.includes('useReducedMotion()') || !listingDetail.includes('prefersReducedMotion ? 0 : 0.2')) fail('Escrow dispute transitions must respect reduced-motion preferences')
if ((listingDetail.match(/ref=\{disputeTriggerRef\}/g) || []).length < 3 || (listingDetail.match(/ref=\{disputeFieldRef\}/g) || []).length < 3) fail('Every escrow dispute entry point must label its field and manage keyboard focus')
if (tokens.spacing.minTouchTarget !== '48px') {
  fail('Design token contract must retain a 48px minimum touch target')
}
if (!tokens.color || !tokens.typography || !tokens.radius || !tokens.motion) {
  fail('Theme tokens must retain color, typography, radius and motion foundations')
}
for (const [name, source, required] of [
  ['notification inbox', notifications, ['const { data, error }', 'aria-live="polite"', 'role="status"', 'sr-only']],
  ['notification toast', notificationToast, ['role="status"', 'aria-live="polite"', 'aria-label={`Dismiss notification:', 'min-h-12 min-w-12']],
  ['offline banner', offlineBanner, ['role="status"', 'aria-live="polite"', 'aria-atomic="true"']],
]) {
  for (const value of required) {
    if (!source.includes(value)) fail(`${name} accessibility contract missing: ${value}`)
  }
}

if (css.includes('#[0-9a-fA-F]{3,8}') || /#[0-9a-fA-F]{3,8}\b/.test(css)) {
  fail('Accessibility layer must consume semantic theme roles, not hard-coded colors')
}

console.log('Design system accessibility regression checks passed.')
