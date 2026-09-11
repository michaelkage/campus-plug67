import React, { Component, type ErrorInfo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, Home, RefreshCw } from 'lucide-react'
import { debugError } from '@/lib/debugger'

interface ErrorBoundaryProps { children: ReactNode }
interface ErrorBoundaryState { hasError: boolean; error: Error | null; showDetails: boolean }

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, showDetails: false }
  static getDerivedStateFromError(error: Error): ErrorBoundaryState { return { hasError: true, error, showDetails: false } }
  componentDidCatch(error: Error, info: ErrorInfo) { debugError('react', 'React render boundary caught an error', { error, componentStack: info.componentStack }); console.error('[CampusPlug] Render boundary caught an error', error, info) }
  reset = () => { this.setState({ hasError: false, error: null, showDetails: false }) }
  render() {
    if (!this.state.hasError) return this.props.children
    return <main className="min-h-screen bg-obsidian-950 text-white flex items-center justify-center p-6"><section className="w-full max-w-xl rounded-2xl border border-plug-red/20 bg-obsidian-900/90 p-6 shadow-2xl shadow-black/30"><div className="flex items-start gap-4"><div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-plug-red/10 text-plug-red"><AlertTriangle size={22}/></div><div><p className="text-[10px] font-bold uppercase tracking-[0.25em] text-plug-red">SYSTEM FAULT</p><h1 className="mt-1 text-2xl font-black tracking-tight">Campus Plug hit a bad signal.</h1><p className="mt-2 text-sm leading-6 text-white/50">The page crashed safely. Your session and stored data were not intentionally cleared.</p></div></div>{this.state.showDetails&&<pre className="mt-5 max-h-40 overflow-auto rounded-xl border border-white/5 bg-black/40 p-4 text-xs text-white/50 whitespace-pre-wrap">{this.state.error?.stack??this.state.error?.message??'Unknown error'}</pre>}<div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-3"><button type="button" onClick={this.reset} className="touch-target inline-flex items-center justify-center gap-2 rounded-xl bg-plug-green px-4 py-3 text-sm font-bold text-obsidian-950 hover:bg-plug-green-600 transition-colors"><RefreshCw size={15}/> Retry</button><Link to="/" className="touch-target inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white hover:border-cyan/40 hover:text-cyan transition-colors"><Home size={15}/> Home</Link><button type="button" onClick={()=>this.setState({showDetails:!this.state.showDetails})} className="touch-target inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-3 text-sm font-bold text-white/50 hover:text-white transition-colors"><ArrowLeft size={15} className="rotate-180"/> Details</button></div></section></main>
  }
}
