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
if (tokens.spacing.minTouchTarget !== '48px') {
  fail('Design token contract must retain a 48px minimum touch target')
}
if (!tokens.color || !tokens.typography || !tokens.radius || !tokens.motion) {
  fail('Theme tokens must retain color, typography, radius and motion foundations')
}
if (css.includes('#[0-9a-fA-F]{3,8}') || /#[0-9a-fA-F]{3,8}\b/.test(css)) {
  fail('Accessibility layer must consume semantic theme roles, not hard-coded colors')
}

console.log('Design system accessibility regression checks passed.')
