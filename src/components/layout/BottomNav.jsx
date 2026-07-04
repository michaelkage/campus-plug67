import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Home, ShoppingBag, Zap, Users, User } from 'lucide-react'

const tabs = [
  { to: '/',            icon: Home,        label: 'Home'    },
  { to: '/marketplace', icon: ShoppingBag, label: 'Market'  },
  { to: '/gigs',        icon: Zap,         label: 'Gigs'    },
  { to: '/pools',       icon: Users,       label: 'Pools'   },
  { to: '/profile',     icon: User,        label: 'Me'      },
]

export default function BottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden
                    bg-obsidian-100/96 backdrop-blur-2xl border-t border-white/5"
         style={{ paddingBottom: 'env(safe-area-inset-bottom, 8px)' }}>
      <div className="flex justify-around items-end pt-2 pb-1">
        {tabs.map(({ to, icon: Icon, label }) => (
          <NavLink key={to} to={to} end={to === '/'}>
            {({ isActive }) => (
              <motion.div
                className="flex flex-col items-center gap-0.5 px-3 py-1 cursor-pointer"
                whileTap={{ scale: 0.85 }}
                transition={{ type: 'spring', stiffness: 600, damping: 30 }}
              >
                <motion.div
                  className={`relative p-2 rounded-xl ${isActive ? 'bg-cyan/15' : ''}`}
                  animate={{ scale: isActive ? 1.1 : 1 }}
                  transition={{ type: 'spring', stiffness: 500, damping: 28 }}
                >
                  <Icon
                    size={18}
                    strokeWidth={isActive ? 2.5 : 1.5}
                    className={`transition-colors ${isActive ? 'text-cyan' : 'text-white/30'}`}
                  />
                  {isActive && (
                    <motion.div
                      layoutId="nav-dot"
                      className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-cyan"
                      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                    />
                  )}
                </motion.div>
                <span className={`text-[9px] font-semibold uppercase tracking-wide transition-colors ${
                  isActive ? 'text-cyan' : 'text-white/25'
                }`}>{label}</span>
              </motion.div>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
