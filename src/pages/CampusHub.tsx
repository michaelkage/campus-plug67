import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Bell, BookOpen, Bot, Bus, FileText, GraduationCap, MapPin, MessageCircle, Plus, Send, Sparkles, Users, X, Zap } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { ReferralCard } from '@/components/ui/Referral'
import { ThemeToggle } from '@/components/ui/ThemeToggle'
import toast from 'react-hot-toast'

const TABS = [
  ['community', 'Community', Users],
  ['classes', 'Classes', GraduationCap],
  ['notes', 'Notes', FileText],
  ['places', 'Campus map', MapPin],
  ['skills', 'Skills', Zap],
  ['rewards', 'Rewards', Sparkles],
] as const

function externalMapsUrl(name: string, university: string) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${university}`)}`
}

function boltUrl(name: string, university: string) {
  return `https://bolt.eu/cities/lagos/` + `?destination=${encodeURIComponent(`${name}, ${university}`)}`
}

export default function CampusHub() {
  const { profile, user } = useAuth()
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('community')
  return (
    <div className="content-width page-gutter py-6 sm:py-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="section-label">Campus Plug OS</p>
          <h1 className="text-3xl font-black tracking-tight">Campus Hub</h1>
          <p className="mt-1 max-w-2xl text-sm text-white/45">Classes, people, notes, campus places, skills and rewards — in one student layer.</p>
        </div>
        <div className="flex items-center gap-2"><ThemeToggle /><Link to="/chat" className="btn-secondary"><MessageCircle size={15}/> Messages</Link></div>