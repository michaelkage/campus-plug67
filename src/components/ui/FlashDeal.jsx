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
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-plug-red/20 text-plug-red text-[10px] font-bold border border-plug-red/30">
      <span>EXPIRED</span>
    </div>
  )

  if (compact) return (
    <motion.div
      animate={isUrgent ? { scale: [1, 1.04, 1] } : {}}
      transition={{ duration: 1, repeat: isUrgent ? Infinity : 0 }}
      className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${
        isUrgent
          ? 'bg-plug-red/20 text-plug-red border-plug-red/40'
          : 'bg-plug-amber/15 text-plug-amber border-plug-amber/30'
      }`}
    >
      <Zap size={9} />
      {timeLeft.h > 0 ? `${timeLeft.h}h ` : ''}{String(timeLeft.m).padStart(2,'0')}:{String(timeLeft.s).padStart(2,'0')}
    </motion.div>
  )

  // Full size
  return (
    <motion.div
      animate={isUrgent ? {
        boxShadow: ['0 0 0 0 rgba(255,68,102,0)', '0 0 16px 4px rgba(255,68,102,0.3)', '0 0 0 0 rgba(255,68,102,0)']
      } : {}}
      transition={{ duration: 1.5, repeat: isUrgent ? Infinity : 0 }}
      className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${
        isUrgent
          ? 'bg-plug-red/10 border-plug-red/30'
          : 'bg-plug-amber/8 border-plug-amber/20'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <motion.div
          animate={{ rotate: [0, 15, -15, 0] }}
          transition={{ duration: 0.5, repeat: Infinity, repeatDelay: 2 }}
        >
          <Zap size={16} className={isUrgent ? 'text-plug-red' : 'text-plug-amber'} />
        </motion.div>
        <span className={`text-xs font-bold uppercase tracking-widest ${
          isUrgent ? 'text-plug-red' : 'text-plug-amber'
        }`}>
          Flash Deal
        </span>
      </div>

      <div className="flex items-center gap-1 ml-auto">
        <Clock size={12} className={isUrgent ? 'text-plug-red' : 'text-plug-amber'} />
        <span className={`font-mono font-black text-sm ${isUrgent ? 'text-plug-red' : 'text-plug-amber'}`}>
          {String(timeLeft.h).padStart(2,'0')}:{String(timeLeft.m).padStart(2,'0')}:{String(timeLeft.s).padStart(2,'0')}
        </span>
      </div>

      {isUrgent && (
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-[10px] font-bold text-plug-red bg-plug-red/20 px-2 py-0.5 rounded-full"
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
        : 'border-obsidian-500 bg-transparent hover:border-plug-amber/20'
    }`} onClick={() => onChange(!value)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
            value ? 'bg-plug-amber/20' : 'bg-obsidian-300'
          }`}>
            <Zap size={16} className={value ? 'text-plug-amber' : 'text-white/30'} />
          </div>
          <div>
            <div className="text-sm font-bold">Flash Deal</div>
            <div className="text-xs text-white/40">Listing expires in 2 hours — creates urgency</div>
          </div>
        </div>
        <div className={`w-10 h-6 rounded-full relative transition-colors duration-200 ${
          value ? 'bg-plug-amber' : 'bg-obsidian-300'
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
            <div className="mt-3 pt-3 border-t border-plug-amber/20 text-xs text-plug-amber">
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
