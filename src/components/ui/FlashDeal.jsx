import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, Clock } from 'lucide-react'

/**
 * FlashDealTimer — a ticking countdown badge for flash deal listings.
 * Shows "2:00:00" counting down to zero.
 * When expired, shows "EXPIRED" in red.
 * Designed to create urgency without being annoying.
 */
export function FlashDealTimer({ expiresAt, compact = false, onExpire }) {
  const [timeLeft, setTimeLeft] = useState(null)

  useEffect(() => {
    if (!expiresAt) return

    const calc = () => {
      const ms = new Date(expiresAt).getTime() - Date.now()
      if (ms <= 0) {
        setTimeLeft(null)
        onExpire?.()
        return
      }
      const h = Math.floor(ms / 3_600_000)
      const m = Math.floor((ms % 3_600_000) / 60_000)
      const s = Math.floor((ms % 60_000) / 1_000)
      setTimeLeft({ h, m, s, ms })
    }

    calc()
    const id = setInterval(calc, 1_000)
    return () => clearInterval(id)
  }, [expiresAt, onExpire])

  if (!expiresAt) return null

  const isUrgent = timeLeft && timeLeft.ms < 30 * 60_000  // last 30 min

  // Expired
  if (!timeLeft) return (
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--md-error)]/20 text-[var(--md-error)] text-[10px] font-bold border border-[var(--md-error)]/30">
      <span>EXPIRED</span>
    </div>
  )

  if (compact) return (
    <motion.div
      animate={isUrgent ? { scale: [1, 1.04, 1] } : {}}
      transition={{ duration: 1, repeat: isUrgent ? Infinity : 0 }}
      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
        isUrgent
          ? 'bg-[var(--md-error)]/20 text-[var(--md-error)] border-plug-red/40'
          : 'bg-[var(--md-secondary)]/15 text-[var(--md-secondary)] border-[var(--md-secondary)]/30'
      }`}
    >
      <Zap size={9} />
      {timeLeft.h > 0 ? `${timeLeft.h}h ` : ''}{String(timeLeft.m).padStart(2,'0')}:{String(timeLeft.s).padStart(2,'0')}
    </motion.div>
  )

  // Full size
  return (
    <motion.div
      
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
        isUrgent
          ? 'bg-[var(--md-error)]/10 border-[var(--md-error)]/30'
          : 'bg-plug-amber/8 border-[var(--md-secondary)]/20'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <motion.div
          animate={{ rotate: [0, 15, -15, 0] }}
          transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 2 }}
        >
          <Zap size={16} className={isUrgent ? 'text-[var(--md-error)]' : 'text-[var(--md-secondary)]'} />
        </motion.div>
        <span className={`text-xs font-bold uppercase tracking-widest ${
          isUrgent ? 'text-[var(--md-error)]' : 'text-[var(--md-secondary)]'
        }`}>
          Flash Deal
        </span>
      </div>

      <div className="flex items-center gap-1 ml-auto">
        <Clock size={12} className={isUrgent ? 'text-[var(--md-error)]' : 'text-[var(--md-secondary)]'} />
        <span className={`font-mono font-black text-sm ${isUrgent ? 'text-[var(--md-error)]' : 'text-[var(--md-secondary)]'}`}>
          {String(timeLeft.h).padStart(2,'0')}:{String(timeLeft.m).padStart(2,'0')}:{String(timeLeft.s).padStart(2,'0')}
        </span>
      </div>

      {isUrgent && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-[10px] font-bold text-[var(--md-error)] bg-[var(--md-error)]/20 px-2 py-0.5 rounded-full"
        >
          ENDING SOON
        </motion.div>
      )}
    </motion.div>
  )
}

/**
 * FlashDealToggle — used in the Create Listing modal.
 * Lets the seller opt in to a flash deal with a 2-hour expiry.
 */
export function FlashDealToggle({ value, onChange }) {
  return (
    <div className={`border rounded-xl p-4 cursor-pointer transition-all duration-200 ${
      value
        ? 'border-plug-amber/40 bg-plug-amber/5'
        : 'border-[var(--md-outline-variant)] bg-transparent hover:border-[var(--md-secondary)]/20'
    }`} onClick={() => onChange(!value)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            value ? 'bg-[var(--md-secondary)]/20' : 'bg-[var(--md-surface-container-high)]'
          }`}>
            <Zap size={16} className={value ? 'text-[var(--md-secondary)]' : 'text-[var(--md-on-surface-variant)]'} />
          </div>
          <div>
            <div className="text-sm font-bold">Flash Deal</div>
            <div className="text-xs text-[var(--md-on-surface-variant)]">Listing expires in 2 hours — creates urgency</div>
          </div>
        </div>
        <div className={`w-10 h-6 rounded-full relative transition-colors duration-200 ${
          value ? 'bg-plug-amber' : 'bg-[var(--md-surface-container-high)]'
        }`}>
          <motion.div
            animate={{ x: value ? 18 : 2 }}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm"
          />
        </div>
      </div>
      <AnimatePresence>
        {value && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 pt-3 border-t border-[var(--md-secondary)]/20 text-xs text-[var(--md-secondary)]">
              ⚡ Your listing will disappear in exactly 2 hours if not sold. Flash deals get 3× more views on average.
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * FlashDealBadge — overlay badge for listing cards.
 * Shows on any card with is_flash_deal = true.
 */
export function FlashDealBadge({ expiresAt }) {
  const [timeLeft, setTimeLeft] = useState('')

  useEffect(() => {
    if (!expiresAt) return
    const calc = () => {
      const ms = new Date(expiresAt).getTime() - Date.now()
      if (ms <= 0) { setTimeLeft('EXPIRED'); return }
      const m = Math.floor(ms / 60_000)
      const s = Math.floor((ms % 60_000) / 1_000)
      setTimeLeft(m > 60 ? `${Math.ceil(m/60)}h` : `${m}:${String(s).padStart(2,'0')}`)
    }
    calc()
    const id = setInterval(calc, 1_000)
    return () => clearInterval(id)
  }, [expiresAt])

  return (
    <motion.div
      animate={{ scale: [1, 1.03, 1] }}
      transition={{ duration: 2, repeat: Infinity }}
      className="flex items-center gap-1 bg-plug-amber/90 text-obsidian px-2 py-0.5 rounded-full text-[10px] font-black"
    >
      <Zap size={8} />
      {timeLeft}
    </motion.div>
  )
}
