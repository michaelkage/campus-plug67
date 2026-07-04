// src/pages/OnboardingComplete.jsx
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'

export default function OnboardingComplete() {
  const navigate = useNavigate()
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) navigate('/', { replace: true })
      else navigate('/auth', { replace: true })
    })
  }, [navigate])

  return (
    <div className="min-h-screen bg-obsidian flex items-center justify-center">
      <div className="text-center">
        <div className="text-5xl mb-4 animate-bounce">⚡</div>
        <p className="text-white/40 text-sm">Plugging you in...</p>
      </div>
    </div>
  )
}
