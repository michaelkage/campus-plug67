import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { initTheme } from './theme/themeEngine'

// Generate and publish the Material 3 palette before the first paint so the
// app never renders unthemed. Cheap: one HCT solve per role.
initTheme()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)