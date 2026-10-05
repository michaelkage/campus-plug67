import { Link } from 'react-router-dom'
import { ArrowLeft, Home, MapPin } from 'lucide-react'

export default function NotFound() {
  return (
    <main className="min-h-screen bg-surface text-white flex items-center justify-center p-6">
      <div className="w-full max-w-2xl text-center">
        <div className="mx-auto mb-6 grid h-20 w-20 place-items-center rounded-2xl border border-primary/20 bg-primary/5 text-primary shadow-lg shadow-primary/5">
          <MapPin size={30} />
        </div>
        <p className="font-mono text-xs font-bold uppercase tracking-[0.35em] text-primary">CAMPUS GRID // 404</p>
        <h1 className="mt-3 text-6xl font-black tracking-tighter sm:text-8xl">LOST?</h1>
        <p className="mx-auto mt-4 max-w-md text-sm leading-6 text-white/45">That route does not exist on the Campus Plug grid. Let’s get you back to somewhere useful.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link to="/" className="touch-target inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-bold text-on-primary hover:bg-primary/90 transition-colors">
            <Home size={16} /> Campus home
          </Link>
          <button type="button" onClick={() => window.history.back()} className="touch-target inline-flex items-center gap-2 rounded-xl border border-white/10 px-5 py-3 text-sm font-bold text-white hover:border-primary/40 hover:text-primary transition-colors">
            <ArrowLeft size={16} /> Go back
          </button>
        </div>
      </div>
    </main>
  )
}
