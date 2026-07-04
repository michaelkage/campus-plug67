import { Link, useNavigate } from 'react-router-dom'
import { Bell, Search } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'

export default function TopNav() {
  const { user, profile, signOut } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  const { data: unreadCount = 0 } = useQuery({
    queryKey: ['unread-notifications', user?.id],
    queryFn: async () => {
      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('read', false)
      return count || 0
    },
    enabled: !!user,
    refetchInterval: 30_000,
  })

  return (
    <nav className="sticky top-0 z-50 h-16 flex items-center justify-between px-4 md:px-8
                    bg-obsidian/90 backdrop-blur-xl border-b border-obsidian-500/50">
      {/* Logo */}
      <Link to="/" className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan to-purple
                        flex items-center justify-center text-obsidian font-black text-sm">
          ⚡
        </div>
        <span className="font-bold text-lg tracking-tight hidden sm:block">
          Campus<span className="text-cyan">Plug</span>
        </span>
      </Link>

      {/* Desktop links */}
      <div className="hidden md:flex items-center gap-6">
        {[
          ['/', 'Home'],
          ['/marketplace', 'Market'],
          ['/gigs', 'Gigs'],
          ['/lost-found', 'Lost & Found'],
          ['/leaderboard', 'Leaderboard'],
        ].map(([path, label]) => (
          <Link
            key={path}
            to={path}
            className="text-sm text-white/50 hover:text-cyan transition-colors font-medium"
          >
            {label}
          </Link>
        ))}
      </div>

      {/* Right actions */}
      <div className="flex items-center gap-3">
        <Link to="/notifications" className="relative p-2 text-white/50 hover:text-cyan transition-colors">
          <Bell size={18} />
          {unreadCount > 0 && (
            <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-plug-red
                             text-white text-[9px] font-bold flex items-center justify-center">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </Link>

        {/* Avatar */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen(v => !v)}
            className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan to-purple
                       flex items-center justify-center text-obsidian font-bold text-xs
                       hover:shadow-cyan transition-shadow"
          >
            {profile?.avatar_url ? (
              <img src={profile.avatar_url} alt="avatar" className="w-full h-full rounded-full object-cover" />
            ) : (
              (profile?.full_name?.[0] || user?.email?.[0] || '?').toUpperCase()
            )}
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-10 w-48 bg-obsidian-400 border border-obsidian-500
                            rounded-xl shadow-card py-2 z-50" onClick={() => setMenuOpen(false)}>
              <div className="px-4 py-2 border-b border-obsidian-500 mb-1">
                <p className="text-sm font-semibold truncate">{profile?.full_name || 'Student'}</p>
                <p className="text-xs text-white/40 truncate">{user?.email}</p>
              </div>
              <Link to="/profile" className="block px-4 py-2 text-sm text-white/60 hover:text-cyan hover:bg-cyan/5">
                My Profile
              </Link>
              <Link to="/marketplace?tab=my-listings" className="block px-4 py-2 text-sm text-white/60 hover:text-cyan hover:bg-cyan/5">
                My Listings
              </Link>
              <button
                onClick={signOut}
                className="w-full text-left px-4 py-2 text-sm text-plug-red/80 hover:text-plug-red hover:bg-plug-red/5"
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  )
}
