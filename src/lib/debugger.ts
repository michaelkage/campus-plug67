/**
 * CampusPlug Runtime Debugger
 *
 * Client-side diagnostics only. Sensitive headers, auth tokens, request bodies,
 * cookies and response payloads are never persisted. Logs are kept in memory and
 * localStorage for the current browser profile so failures can be exported.
 */

export type DebugLevel = 'trace' | 'info' | 'warn' | 'error' | 'success'
export type DebugCategory = 'app' | 'network' | 'supabase' | 'auth' | 'navigation' | 'react' | 'storage' | 'performance' | 'user' | 'error'

export interface DebugEvent {
  id: string
  ts: string
  level: DebugLevel
  category: DebugCategory
  message: string
  data?: Record<string, unknown>
  durationMs?: number
  traceId?: string
}

const STORAGE_KEY = 'cp_runtime_debugger_v1'
const MAX_EVENTS = 1500
const MAX_STORAGE_EVENTS = 800
const MAX_VALUE_LENGTH = 500

let events: DebugEvent[] = []
let listeners = new Set<(events: DebugEvent[]) => void>()
let initialized = false
let paused = false
let originalConsole: Partial<Console> = {}
let originalFetch: typeof window.fetch | null = null

const safeString = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_LENGTH)
  try { return JSON.stringify(value).slice(0, MAX_VALUE_LENGTH) } catch { return String(value).slice(0, MAX_VALUE_LENGTH) }
}

const sanitize = (value: unknown, depth = 0): unknown => {
  if (depth > 3) return '[depth-limit]'
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_LENGTH)
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 8).join('\n') }
  if (Array.isArray(value)) return value.slice(0, 30).map(v => sanitize(v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      const lower = key.toLowerCase()
      if (lower.includes('authorization') || lower.includes('apikey') || lower.includes('token') || lower.includes('password') || lower.includes('cookie') || lower.includes('secret')) {
        out[key] = '[redacted]'
      } else out[key] = sanitize(val, depth + 1)
    }
    return out
  }
  return safeString(value)
}

const notify = () => {
  const snapshot = [...events]
  listeners.forEach(fn => { try { fn(snapshot) } catch {} })
}

const persist = () => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_STORAGE_EVENTS))) } catch {}
}

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
const makeTraceId = () => `tr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

export const debugLog = (level: DebugLevel, category: DebugCategory, message: string, data?: Record<string, unknown>, durationMs?: number, traceId?: string) => {
  if (paused) return
  const event: DebugEvent = {
    id: makeId(), ts: new Date().toISOString(), level, category,
    message: message.slice(0, 300),
    data: data ? sanitize(data) as Record<string, unknown> : undefined,
    durationMs, traceId,
  }
  events.push(event)
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS)
  persist()
  notify()
}

export const debugTrace = (message: string, data?: Record<string, unknown>, traceId?: string) => debugLog('trace', 'app', message, data, undefined, traceId)
export const debugInfo = (category: DebugCategory, message: string, data?: Record<string, unknown>, traceId?: string) => debugLog('info', category, message, data, undefined, traceId)
export const debugWarn = (category: DebugCategory, message: string, data?: Record<string, unknown>, traceId?: string) => debugLog('warn', category, message, data, undefined, traceId)
export const debugError = (category: DebugCategory, message: string, data?: Record<string, unknown>, traceId?: string) => debugLog('error', category, message, data, undefined, traceId)
export const debugSuccess = (category: DebugCategory, message: string, data?: Record<string, unknown>, durationMs?: number, traceId?: string) => debugLog('success', category, message, data, durationMs, traceId)

export const startDebugTrace = (name: string, data?: Record<string, unknown>) => {
  const traceId = makeTraceId()
  const started = performance.now()
  debugTrace(`TRACE START: ${name}`, data, traceId)
  return {
    traceId,
    end(message = `TRACE END: ${name}`, extra?: Record<string, unknown>) {
      const duration = Math.round(performance.now() - started)
      debugSuccess('performance', message, extra, duration, traceId)
      return duration
    },
    fail(error: unknown, extra?: Record<string, unknown>) {
      const duration = Math.round(performance.now() - started)
      debugError('error', `TRACE FAILED: ${name}`, { error, ...extra }, traceId)
      debugLog('error', 'performance', `TRACE DURATION: ${name}`, extra, duration, traceId)
      return duration
    },
  }
}

const classifyUrl = (rawUrl: string) => {
  try {
    const url = new URL(rawUrl, window.location.origin)
    const path = url.pathname
    if (path.includes('/rest/v1/rpc/')) return { service: 'supabase-rpc', resource: path.split('/rest/v1/rpc/')[1] }
    if (path.includes('/rest/v1/')) return { service: 'supabase-rest', resource: path.split('/rest/v1/')[1] }
    if (path.includes('/functions/v1/')) return { service: 'supabase-function', resource: path.split('/functions/v1/')[1] }
    return { service: 'http', resource: path }
  } catch { return { service: 'http', resource: rawUrl.slice(0, 160) } }
}

const summarizeResponse = async (response: Response) => {
  try {
    const clone = response.clone()
    const text = await clone.text()
    let summary: Record<string, unknown> = { bytes: text.length }
    if (text) {
      try {
        const parsed = JSON.parse(text)
        summary = {
          ...summary,
          kind: Array.isArray(parsed) ? 'array' : typeof parsed,
          count: Array.isArray(parsed) ? parsed.length : undefined,
          errorCode: parsed?.code,
          errorMessage: parsed?.message || parsed?.error_description,
          hint: parsed?.hint,
        }
      } catch {}
    }
    return summary
  } catch { return {} }
}

export const debugFetch: typeof window.fetch = async (input, init) => {
  const started = performance.now()
  const requestId = makeTraceId()
  const request = new Request(input, init)
  const url = request.url
  const method = request.method
  const { service, resource } = classifyUrl(url)
  const query = (() => {
    try {
      const u = new URL(url)
      const entries = [...u.searchParams.entries()].filter(([k]) => !/(token|key|secret|password)/i.test(k))
      return Object.fromEntries(entries).slice
    } catch { return undefined }
  })()

  debugTrace(`HTTP ${method} ${resource}`, { requestId, service, method, resource, query }, requestId)
  try {
    const response = await (originalFetch || window.fetch)(request)
    const duration = Math.round(performance.now() - started)
    const responseSummary = await summarizeResponse(response)
    const category: DebugCategory = service.startsWith('supabase') ? 'supabase' : 'network'
    if (response.ok) debugSuccess(category, `HTTP ${response.status} ${method} ${resource}`, { requestId, service, resource, ...responseSummary }, duration, requestId)
    else debugError(category, `HTTP ${response.status} ${method} ${resource}`, { requestId, service, resource, ...responseSummary }, requestId)
    return response
  } catch (error) {
    const duration = Math.round(performance.now() - started)
    debugError('network', `HTTP FAILED ${method} ${resource}`, { requestId, service, resource, error }, requestId)
    debugLog('error', 'performance', `HTTP DURATION ${method} ${resource}`, {}, duration, requestId)
    throw error
  }
}

export const subscribeDebugger = (listener: (events: DebugEvent[]) => void) => {
  listeners.add(listener)
  listener([...events])
  return () => listeners.delete(listener)
}

export const getDebugEvents = () => [...events]
export const clearDebugEvents = () => { events = []; persist(); notify() }
export const setDebugPaused = (value: boolean) => { paused = value; debugInfo('app', value ? 'Debugger paused' : 'Debugger resumed') }
export const isDebugPaused = () => paused

export const exportDebugBundle = () => {
  const payload = {
    exportedAt: new Date().toISOString(),
    app: 'CampusPlug',
    url: window.location.href.split('?')[0],
    userAgent: navigator.userAgent,
    online: navigator.onLine,
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    events: getDebugEvents(),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a'); a.href = url; a.download = `campusplug-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`; a.click()
  URL.revokeObjectURL(url)
}

export const installRuntimeDebugger = () => {
  if (initialized || typeof window === 'undefined') return
  initialized = true

  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      if (Array.isArray(parsed)) events = parsed.slice(-MAX_EVENTS)
    }
  } catch {}

  originalConsole = { error: console.error, warn: console.warn }
  console.error = (...args) => { debugError('error', 'console.error', { args: args.map(safeString) }); originalConsole.error?.(...args) }
  console.warn = (...args) => { debugWarn('app', 'console.warn', { args: args.map(safeString) }); originalConsole.warn?.(...args) }

  originalFetch = window.fetch.bind(window)
  window.fetch = debugFetch

  window.addEventListener('error', event => debugError('error', 'window.error', { message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error }))
  window.addEventListener('unhandledrejection', event => debugError('error', 'unhandledrejection', { reason: event.reason }))
  window.addEventListener('online', () => debugSuccess('network', 'Browser is online'))
  window.addEventListener('offline', () => debugWarn('network', 'Browser went offline'))
  window.addEventListener('pagehide', () => debugInfo('navigation', 'Page hidden'))
  window.addEventListener('pageshow', event => debugInfo('navigation', 'Page shown', { persisted: event.persisted }))
  window.addEventListener('popstate', () => debugInfo('navigation', 'History navigation', { path: window.location.pathname }))

  const originalPush = history.pushState
  history.pushState = function(...args) { const result = originalPush.apply(this, args); debugInfo('navigation', 'pushState', { path: window.location.pathname }); return result }
  const originalReplace = history.replaceState
  history.replaceState = function(...args) { const result = originalReplace.apply(this, args); debugInfo('navigation', 'replaceState', { path: window.location.pathname }); return result }

  debugSuccess('app', 'Runtime debugger initialized', { version: '1.0.0', maxEvents: MAX_EVENTS })
}

export const getDebuggerStats = () => {
  const counts = events.reduce((acc, e) => { acc[e.level] = (acc[e.level] || 0) + 1; return acc }, {} as Record<string, number>)
  return { total: events.length, errors: counts.error || 0, warnings: counts.warn || 0, traces: counts.trace || 0, lastEvent: events.at(-1)?.ts || null }
}
