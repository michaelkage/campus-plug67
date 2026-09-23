import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Home, RefreshCw } from 'lucide-react'
import { debugError } from '@/lib/debugger'

interface ErrorBoundaryProps { children: ReactNode }
interface ErrorBoundaryState { hasError: boolean; error: Error | null; showDetails: boolean }

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, showDetails: false }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { hasError: true, error, showDetails: false } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    debugError('react', 'React render boundary caught an error', { error, componentStack: info.componentStack })
    console.error('[CampusPlug] Render boundary caught an error', error, info)
  }
  reset = () => { this.setState({ hasError: false, error: null, showDetails: false }) }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <main className="flex min-h-screen items-center justify-center bg-[var(--md-surface)] px-6 py-10 text-[var(--md-on-surface)]">
        <section className="w-full max-w-xl rounded-3xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container)] p-6 shadow-[var(--md-elevation-2)] sm:p-8">
          <div className="flex items-start gap-4">
            <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[var(--md-error-container)] text-[var(--md-on-error-container)]">
              <AlertTriangle size={22} />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--md-error)]">Something went wrong</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Campus Plug hit a bad signal.</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--md-on-surface-variant)]">The page crashed safely. Your session and stored data were not intentionally cleared.</p>
            </div>
          </div>

          {this.state.showDetails && (
            <pre className="mt-5 max-h-40 overflow-auto rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-high)] p-4 text-xs leading-5 text-[var(--md-on-surface-variant)] whitespace-pre-wrap">
              {this.state.error?.stack ?? this.state.error?.message ?? 'Unknown error'}
            </pre>
          )}

          <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button type="button" onClick={this.reset} className="touch-target inline-flex items-center justify-center gap-2 rounded-full bg-[var(--md-primary)] px-4 text-sm font-semibold text-[var(--md-on-primary)] hover:opacity-90 transition-opacity">
              <RefreshCw size={16} /> Retry
            </button>
            <Link to="/" className="touch-target inline-flex items-center justify-center gap-2 rounded-full border border-[var(--md-outline)] px-4 text-sm font-semibold text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] transition-colors">
              <Home size={16} /> Home
            </Link>
            <button type="button" onClick={() => this.setState({ showDetails: !this.state.showDetails })} className="touch-target inline-flex items-center justify-center gap-2 rounded-full border border-[var(--md-outline)] px-4 text-sm font-semibold text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)] transition-colors">
              <ArrowLeft size={16} className="rotate-180" /> Details
            </button>
          </div>
        </section>
      </main>
    )
  }
}
