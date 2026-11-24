import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import TopNav from './TopNav'
import BottomNav from './BottomNav'
import NotificationBanner from '@/components/ui/NotificationBanner'

export default function Layout() {
  const location = useLocation()
  const reduceMotion = useReducedMotion()

  return (
    <div className="app-shell flex min-h-screen flex-col bg-surface text-on-surface">
      <a className="cp-skip-link" href="#main-content">Skip to main content</a>
      <div className="app-ambient" aria-hidden="true" />
      <TopNav />
      <NotificationBanner />
      <main id="main-content" tabIndex={-1} className="app-main relative z-10 flex-1 pb-20 outline-none md:pb-0">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={location.pathname}
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: -5 }}
            transition={{ duration: reduceMotion ? 0 : 0.18, ease: 'easeOut' }}
            className="min-h-full"
          >
            <Outlet />
          </motion.div>
        </AnimatePresence>
      </main>
      <BottomNav />
    </div>
  )
}
