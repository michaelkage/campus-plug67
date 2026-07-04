import { Outlet } from 'react-router-dom'
import TopNav from './TopNav'
import BottomNav from './BottomNav'
import NotificationBanner from '@/components/ui/NotificationBanner'

export default function Layout() {
  return (
    <div className="min-h-screen bg-obsidian flex flex-col">
      <TopNav />
      <NotificationBanner />
      <main className="flex-1 pb-20 md:pb-0">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  )
}
