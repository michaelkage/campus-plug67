import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/AuthContext'
import { ArrowRight, Eye, EyeOff, Fingerprint, LockKeyhole, Mail, ShieldCheck, Zap } from 'lucide-react'

const UNIVERSITIES = [
  'University of Lagos (UNILAG)',
  'Obafemi Awolowo University (OAU)',
  'University of Ibadan (UI)',
  'University of Benin (UNIBEN)',
  'Ahmadu Bello University (ABU)',
  'Yaba College of Technology (YABATECH)',
  'Lagos State University (LASU)',
  'University of Nigeria Nsukka (UNN)',
  'Other',
]

const features = [
  { title: 'Your campus, connected', text: 'Find people, services, opportunities and things happening around you.' },
  { title: 'Built for students', text: 'One account for the everyday tools that make campus life easier.' },
  { title: 'Privacy first', text: 'Your account and activity are protected with modern security controls.' },
]

export default function Auth() {
  const { isAuthenticated, signIn, signUp, signInWithPasskey, passkeySupported } = useAuth()
  const [mode, setMode] = useState('signin')
  const [showPass, setShowPass] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [form, setForm] = useState({ email: '', password: '', fullName: '', university: '', matric: '' })

  if (isAuthenticated) return <Navigate to="/" replace />

  const set = key => event => setForm(current => ({ ...current, [key]: event.target.value }))

  const switchMode = nextMode => {
    if (submitting) return
    setMode(nextMode)
  }

  const handleSubmit = async event => {
    event.preventDefault()
    setSubmitting(true)

    try {
      if (mode === 'signin') {
        await signIn({ email: form.email, password: form.password })
      } else {
        await signUp({
          email: form.email,
          password: form.password,
          fullName: form.fullName,
          university: form.university,
          matric: form.matric,
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasskey = async () => {
    if (!form.email) {
      alert('Enter your email first')
      return
    }

    setPasskeyLoading(true)
    try {
      await signInWithPasskey(form.email)
    } finally {
      setPasskeyLoading(false)
    }
  }

  return (
    <main className="min-h-screen bg-[#080B10] text-white selection:bg-cyan/30">
      <div className="min-h-screen lg:grid lg:grid-cols-[minmax(360px,0.95fr)_minmax(520px,1.05fr)]">
        {/* Brand panel */}
        <section className="relative hidden overflow-hidden border-r border-white/[0.07] bg-[#0C1017] lg:flex lg:flex-col lg:justify-between lg:p-10 xl:p-14">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_15%,rgba(0,229,255,0.10),transparent_30%),radial-gradient(circle_at_85%_85%,rgba(168,85,247,0.08),transparent_32%)]" />
          <div className="absolute inset-0 opacity-[0.035] [background-image:linear-gradient(rgba(255,255,255,1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,1)_1px,transparent_1px)] [background-size:44px_44px]" />

          <div className="relative z-10">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan text-[#061014] shadow-[0_0_30px_rgba(0,229,255,0.16)]">
                <Zap size={20} strokeWidth={2.5} />
              </div>
              <span className="text-xl font-black tracking-tight">Campus<span className="text-cyan">Plug</span></span>
            </div>

            <div className="mt-24 max-w-xl">
              <p className="mb-5 text-xs font-bold uppercase tracking-[0.22em] text-cyan/70">The student network</p>
              <h2 className="text-4xl font-black leading-[1.08] tracking-[-0.03em] xl:text-5xl">
                Campus life,
                <br />
                <span className="text-white/45">without the friction.</span>
              </h2>
              <p className="mt-6 max-w-md text-base leading-7 text-white/45">
                A focused campus ecosystem for discovering people, opportunities, services and the things that matter day to day.
              </p>
            </div>

            <div className="mt-14 space-y-5">
              {features.map((feature, index) => (
                <div key={feature.title} className="flex gap-4">
                  <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-xs font-bold text-cyan">
                    0{index + 1}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-white/85">{feature.title}</p>
                    <p className="mt-1 max-w-sm text-sm leading-6 text-white/35">{feature.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative z-10 flex items-center gap-2 text-xs text-white/25">
            <span className="h-1.5 w-1.5 rounded-full bg-plug-green shadow-[0_0_10px_rgba(0,255,136,0.5)]" />
            Built for students, by Campus Plug
          </div>
        </section>

        {/* Auth panel */}
        <section className="relative flex min-h-screen items-center justify-center overflow-hidden px-5 py-8 sm:px-8 lg:min-h-0 lg:px-12 xl:px-20">
          <div className="pointer-events-none absolute -left-32 top-1/3 h-72 w-72 rounded-full bg-cyan/[0.035] blur-3xl" />
          <div className="pointer-events-none absolute -right-32 bottom-0 h-80 w-80 rounded-full bg-purple/[0.035] blur-3xl" />

          <motion.div
            className="relative z-10 w-full max-w-[460px]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          >
            <div className="mb-8 lg:hidden">
              <div className="mb-7 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan text-[#061014]">
                  <Zap size={20} strokeWidth={2.5} />
                </div>
                <span className="text-xl font-black tracking-tight">Campus<span className="text-cyan">Plug</span></span>
              </div>
            </div>

            <header className="mb-7">
              <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-cyan/70">
                {mode === 'signin' ? 'Welcome back' : 'Get started'}
              </p>
              <h1 className="text-3xl font-black tracking-[-0.03em] sm:text-[34px]">
                {mode === 'signin' ? 'Sign in to Campus Plug' : 'Create your student account'}
              </h1>
              <p className="mt-2 text-sm leading-6 text-white/40">
                {mode === 'signin'
                  ? 'Use your university email to continue where you left off.'
                  : 'Join your campus community in a few quick steps.'}
              </p>
            </header>

            <div className="mb-7 grid grid-cols-2 rounded-xl border border-white/[0.07] bg-white/[0.025] p-1">
              <button
                type="button"
                onClick={() => switchMode('signin')}
                aria-pressed={mode === 'signin'}
                className={`min-h-11 rounded-[9px] px-4 text-sm font-bold transition-all ${mode === 'signin' ? 'bg-white text-[#090C11] shadow-sm' : 'text-white/40 hover:text-white/70'}`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => switchMode('signup')}
                aria-pressed={mode === 'signup'}
                className={`min-h-11 rounded-[9px] px-4 text-sm font-bold transition-all ${mode === 'signup' ? 'bg-white text-[#090C11] shadow-sm' : 'text-white/40 hover:text-white/70'}`}
              >
                Create account
              </button>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.025] p-5 shadow-[0_24px_80px_rgba(0,0,0,0.25)] sm:p-7">
              <div className="mb-6 flex items-center gap-3 rounded-xl border border-white/[0.06] bg-black/10 px-3.5 py-3">
                <ShieldCheck size={17} className="shrink-0 text-plug-green" />
                <div>
                  <p className="text-xs font-bold text-white/70">Secure student access</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-white/30">Your credentials are protected and your university identity is verified.</p>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                <AnimatePresence initial={false} mode="popLayout">
                  {mode === 'signup' && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <label className="label" htmlFor="full-name">Full name</label>
                      <input id="full-name" className="input" type="text" placeholder="Oluwafemi Adeyemi" value={form.fullName} onChange={set('fullName')} required />
                    </motion.div>
                  )}
                </AnimatePresence>

                <div>
                  <label className="label" htmlFor="university-email">University email</label>
                  <div className="relative">
                    <Mail size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" />
                    <input id="university-email" className="input pl-10" type="email" placeholder="your.name@unilag.edu.ng" value={form.email} onChange={set('email')} required />
                  </div>
                  {mode === 'signup' && (
                    <p className="mt-2 text-[11px] leading-4 text-white/30">
                      Use an approved university email. We verify it against the campus allowlist.
                    </p>
                  )}
                </div>

                <AnimatePresence initial={false} mode="popLayout">
                  {mode === 'signup' && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden space-y-4"
                    >
                      <div>
                        <label className="label" htmlFor="university">University</label>
                        <select id="university" className="input" value={form.university} onChange={set('university')} required>
                          <option value="">Select your university</option>
                          {UNIVERSITIES.map(university => <option key={university} value={university}>{university}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="label" htmlFor="matric-number">Matric number <span className="font-normal text-white/20">(optional)</span></label>
                        <input id="matric-number" className="input" type="text" placeholder="e.g. 190402056" value={form.matric} onChange={set('matric')} />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div>
                  <label className="label" htmlFor="password">Password</label>
                  <div className="relative">
                    <LockKeyhole size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" />
                    <input id="password" className="input pl-10 pr-11" type={showPass ? 'text' : 'password'} placeholder="Min 8 characters" value={form.password} onChange={set('password')} minLength={8} required />
                    <button
                      type="button"
                      onClick={() => setShowPass(value => !value)}
                      aria-label={showPass ? 'Hide password' : 'Show password'}
                      className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-white/25 transition-colors hover:bg-white/[0.05] hover:text-white/60"
                    >
                      {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  className="group flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-plug-green px-4 font-black text-[#06110B] transition-all hover:bg-[#1AFF9A] hover:shadow-[0_8px_30px_rgba(0,255,136,0.14)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}
                  {!submitting && <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />}
                </button>
              </form>

              {mode === 'signin' && passkeySupported && (
                <div className="mt-5">
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-1 bg-white/[0.07]" />
                    <span className="text-[11px] font-medium uppercase tracking-wider text-white/20">or</span>
                    <div className="h-px flex-1 bg-white/[0.07]" />
                  </div>
                  <motion.button
                    type="button"
                    onClick={handlePasskey}
                    disabled={passkeyLoading || !form.email}
                    whileTap={{ scale: 0.985 }}
                    className="mt-4 flex min-h-12 w-full items-center justify-center gap-2.5 rounded-xl border border-white/[0.09] bg-white/[0.025] text-sm font-bold text-white/70 transition-colors hover:border-cyan/25 hover:bg-cyan/[0.04] hover:text-cyan disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    <Fingerprint size={17} className={passkeyLoading ? 'animate-pulse' : ''} />
                    {passkeyLoading ? 'Verifying…' : 'Use Face ID or fingerprint'}
                  </motion.button>
                  {!form.email && <p className="mt-2 text-center text-[11px] text-white/20">Enter your email first to use passkey sign-in.</p>}
                </div>
              )}

              {mode === 'signup' && (
                <p className="mt-5 text-center text-[11px] leading-5 text-white/25">
                  By creating an account, you confirm that you are a registered student. Device fingerprinting may be used for fraud prevention.
                </p>
              )}
            </div>

            <div className="mt-6 flex items-center justify-center gap-2 text-[11px] text-white/20">
              <LockKeyhole size={12} />
              Secure connection · Campus Plug
            </div>
          </motion.div>
        </section>
      </div>
    </main>
  )
}
