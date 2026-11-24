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
if (!settings.includes('aria-live="polite"') || !settings.includes('role="status"')) fail('Preference save state must be announced to assistive technology')
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
