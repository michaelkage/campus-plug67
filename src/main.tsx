import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { initTheme } from './theme/themeEngine'

// Generate and publish the Material 3 palette before the first paint so the
// app never renders unthemed. Cheap: one HCT solve per role.
initTheme()

// Preserve actionable diagnostics for runtime failures. Avoid logging page contents,
// credentials, or arbitrary request bodies.
window.addEventListener('error', (event) => {
  console.error('[CampusPlug runtime error]', {
    message: event.message || 'Unknown runtime error',
    filename: event.filename || (event.target instanceof HTMLScriptElement ? event.target.src : ''),
    line: event.lineno || 0,
    column: event.colno || 0,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  console.error('[CampusPlug unhandled rejection]', {
    message: reason instanceof Error ? reason.message : String(reason ?? 'Unknown rejection'),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)