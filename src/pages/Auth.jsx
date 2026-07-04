import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuth } from '@/contexts/AuthContext'
import { Eye, EyeOff, Fingerprint, Shield, Zap, AlertTriangle } from 'lucide-react'

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

export default function Auth() {
  const { isAuthenticated, signIn, signUp, signInWithPasskey, passkeySupported, loading } = useAuth()
  const [mode, setMode]         = useState('signin')   // signin | signup
  const [showPass, setShowPass] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [passkeyLoading, setPasskeyLoading] = useState(false)
  const [form, setForm] = useState({ email:'', password:'', fullName:'', university:'', matric:'' })

  if (isAuthenticated) return <Navigate to="/" replace />

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    if (mode === 'signin') {
      await signIn({ email: form.email, password: form.password })
    } else {
      await signUp({ email: form.email, password: form.password, fullName: form.fullName, university: form.university, matric: form.matric })
    }
    setSubmitting(false)
  }

  const handlePasskey = async () => {
    if (!form.email) { alert('Enter your email first'); return }
    setPasskeyLoading(true)
    await signInWithPasskey(form.email)
    setPasskeyLoading(false)
  }

  return (
    <div className="min-h-screen bg-obsidian flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 cyber-grid opacity-50 [mask-image:radial-gradient(ellipse_80%_80%_at_50%_50%,black,transparent)]" />
      <div className="absolute w-96 h-96 rounded-full bg-cyan/5 -top-20 -left-20 blur-3xl pointer-events-none" />
      <div className="absolute w-80 h-80 rounded-full bg-purple/6 -bottom-16 -right-16 blur-3xl pointer-events-none" />

      <motion.div
        className="relative z-10 w-full max-w-md"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.25, 0.1, 0.25, 1] }}
      >
        {/* Logo */}
        <div className="text-center mb-8">
          <motion.div
            className="inline-flex items-center justify-center w-14 h-14 rounded-2xl
                       bg-gradient-to-br from-cyan to-purple text-obsidian font-black text-2xl mb-4 shadow-cyan"
            animate={{ boxShadow: ['0 0 20px rgba(0,242,255,0.3)', '0 0 40px rgba(0,242,255,0.6)', '0 0 20px rgba(0,242,255,0.3)'] }}
            transition={{ duration: 2.5, repeat: Infinity }}
          >
            <Zap size={28} />
          </motion.div>
          <h1 className="text-2xl font-black tracking-tight">
            Campus<span className="text-cyan">Plug</span>
          </h1>
          <p className="text-sm text-white/40 mt-1">
            {mode === 'signin' ? 'Welcome back, student.' : 'Join your campus ecosystem.'}
          </p>
        </div>

        {/* Card */}
        <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-8 shadow-card">

          {/* Security badges */}
          <div className="flex items-center gap-3 mb-5 p-3 rounded-xl bg-obsidian-300">
            <Shield size={13} className="text-plug-green flex-shrink-0" />
            <div className="text-xs text-white/40 leading-relaxed">
              EDU email verified · Device fingerprinted · End-to-end encrypted
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex bg-obsidian-300 rounded-xl p-1 mb-6">
            {['signin', 'signup'].map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all duration-200 ${
                  mode === m ? 'bg-cyan text-obsidian shadow-sm' : 'text-white/40 hover:text-white/70'
                }`}>
                {m === 'signin' ? 'Sign In' : 'Sign Up'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <AnimatePresence>
              {mode === 'signup' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <label className="label">Full Name</label>
                  <input className="input" type="text" placeholder="Oluwafemi Adeyemi"
                    value={form.fullName} onChange={set('fullName')} required={mode === 'signup'} />
                </motion.div>
              )}
            </AnimatePresence>

            <div>
              <label className="label">University Email</label>
              <input className="input" type="email" placeholder="your.name@unilag.edu.ng"
                value={form.email} onChange={set('email')} required />
              {mode === 'signup' && (
                <p className="text-xs text-white/30 mt-1.5 flex items-center gap-1">
                  <Shield size={10} className="text-cyan" />
                  Must be a valid .edu.ng or .edu address — verified on sign up
                </p>
              )}
            </div>

            <AnimatePresence>
              {mode === 'signup' && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden space-y-4"
                >
                  <div>
                    <label className="label">University</label>
                    <select className="input" value={form.university} onChange={set('university')} required={mode === 'signup'}>
                      <option value="">Select your university</option>
                      {UNIVERSITIES.map(u => <option key={u} value={u}>{u}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">Matric Number (optional)</label>
                    <input className="input" type="text" placeholder="e.g. 190402056"
                      value={form.matric} onChange={set('matric')} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div>
              <label className="label">Password</label>
              <div className="relative">
                <input
                  className="input pr-10"
                  type={showPass ? 'text' : 'password'}
                  placeholder="Min 8 characters"
                  value={form.password}
                  onChange={set('password')}
                  minLength={8}
                  required
                />
                <button type="button" onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={submitting}
              className="btn-primary w-full mt-2 disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? 'Loading...' : mode === 'signin' ? 'Sign In' : 'Create Account'}
            </button>
          </form>

          {/* Passkey login divider */}
          {mode === 'signin' && passkeySupported && (
            <div className="mt-4">
              <div className="flex items-center gap-3 my-4">
                <div className="flex-1 h-px bg-obsidian-500" />
                <span className="text-xs text-white/30">or</span>
                <div className="flex-1 h-px bg-obsidian-500" />
              </div>
              <motion.button
                onClick={handlePasskey}
                disabled={passkeyLoading || !form.email}
                whileTap={{ scale: 0.97 }}
                className="w-full py-3 rounded-xl border border-cyan/30 bg-cyan/5 text-cyan
                           font-semibold text-sm flex items-center justify-center gap-2.5
                           hover:bg-cyan/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Fingerprint size={17} className={passkeyLoading ? 'animate-pulse' : ''} />
                {passkeyLoading ? 'Verifying biometrics...' : 'Sign in with Face ID / Fingerprint'}
              </motion.button>
              {!form.email && (
                <p className="text-xs text-white/25 text-center mt-2">Enter your email above first</p>
              )}
            </div>
          )}

          {mode === 'signup' && (
            <p className="text-xs text-center text-white/25 mt-4">
              By signing up you confirm you are a registered student. Your device fingerprint
              is collected to prevent fraud and scam accounts.
            </p>
          )}
        </div>

        {/* Social proof */}
        <div className="text-center mt-6">
          <div className="inline-flex items-center gap-2 text-xs text-white/30">
            <div className="plug-dot scale-75" />
            12,400+ students already plugged in
          </div>
        </div>
      </motion.div>
    </div>
  )
}
