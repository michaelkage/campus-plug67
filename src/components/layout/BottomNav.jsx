/* eslint-disable no-hardcoded-colors/no-hardcoded-colors */
import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Home, ShoppingBag, MessageCircle, Users, User, WalletCards } from 'lucide-react'

const tabs = [
  { to: '/', icon: Home, label: 'Home' },
  { to: '/marketplace', icon: ShoppingBag, label: 'Market' },
  { to: '/chat', icon: MessageCircle, label: 'Chat' },
  { to: '/study-pools', icon: Users, label: 'Pools' },
  { to: '/wallet', icon: WalletCards, label: 'Wallet' },
  { to: '/profile', icon: User, label: 'Me' },
]

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 border-t border-outline-variant bg-surface/95 shadow-none backdrop-blur-none md:hidden" style={{paddingBottom:'env(safe-area-inset-bottom, 8px)'}} aria-label="Primary navigation">
      <div className="mx-auto flex max-w-lg items-end justify-around px-1 pt-1.5 pb-1">
        {tabs.map(({to,icon:Icon,label})=><NavLink key={to} to={to} end={to==='/' } className="min-h-12 min-w-11 flex-1" aria-label={label}>
          {({isActive})=><motion.div className="relative flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-md px-2 py-1" whileTap={{y:1}}>
            <motion.div className={`relative rounded-md p-2 transition-colors ${isActive?'bg-primary/15':'bg-transparent'}`} >
              <Icon size={18} strokeWidth={isActive?2.5:1.7} className={isActive?'text-primary':'text-on-surface-variant'} />
              {isActive&&<motion.div layoutId="nav-dot" className="absolute -bottom-0.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-sm bg-primary" />}
            </motion.div>
            <span className={`text-[9px] font-semibold tracking-wide transition-colors ${isActive?'text-primary':'text-on-surface-variant'}`}>{label}</span>
          </motion.div>}
        </NavLink>)}
      </div>
    </nav>
  )
}
