import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Home, ShoppingBag, Zap, Users, User } from 'lucide-react'

const tabs = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/marketplace', icon: ShoppingBag, label: 'Market' },
  { to: '/gigs', icon: Zap, label: 'Gigs' },
  { to: '/study-pools', icon: Users, label: 'Pools' },
  { to: '/profile', icon: User, label: 'Me' },
]

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/[0.07] bg-obsidian-900/90 backdrop-blur-2xl md:hidden" style={{paddingBottom:'env(safe-area-inset-bottom, 8px)'}} aria-label="Primary navigation">
      <div className="mx-auto flex max-w-lg items-end justify-around px-1 pt-1.5 pb-1">
        {tabs.map(({to,icon:Icon,label})=><NavLink key={to} to={to} end={to==='/' } className="min-h-11 min-w-11 flex-1">
          {({isActive})=><motion.div className="relative flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1" whileTap={{scale:.94}}>
            <motion.div className={`relative rounded-xl p-2 transition-colors ${isActive?'bg-cyan/12':'bg-transparent'}`} animate={{scale:isActive?1.04:1}}>
              <Icon size={18} strokeWidth={isActive?2.5:1.7} className={isActive?'text-cyan':'text-white/35'} />
              {isActive&&<motion.div layoutId="nav-dot" className="absolute -bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-cyan" />}
            </motion.div>
            <span className={`text-[9px] font-semibold tracking-wide transition-colors ${isActive?'text-cyan':'text-white/30'}`}>{label}</span>
          </motion.div>}
        </NavLink>)}
      </div>
    </nav>
  )
}
