import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { MessageCircle, ArrowRight, Search, ShieldCheck } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'

export default function Chat() {
  const { user } = useAuth()
  const { data: messages = [], isLoading, isError } = useQuery({
    queryKey: ['chat-inbox', user?.id],
    enabled: !!user,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('messages').select('id,sender_id,receiver_id,content,created_at,read,transaction_id').or(`sender_id.eq.${user!.id},receiver_id.eq.${user!.id}`).order('created_at', { ascending: false }).limit(500)
      if (error) throw error
      return data ?? []
    },
  })
  const conversationUserIds = useMemo(() => user ? [...new Set(messages.map(message => message.sender_id === user.id ? message.receiver_id : message.sender_id))] : [], [messages, user])
  const { data: profiles = [] } = useQuery({
    queryKey: ['chat-inbox-profiles', conversationUserIds],
    enabled: conversationUserIds.length > 0,
    queryFn: async () => { const { data, error } = await supabase.from('profiles').select('id,full_name,avatar_url,university').in('id', conversationUserIds); if (error) throw error; return data ?? [] },
  })
  const conversations = useMemo(() => {
    const profileMap = new Map(profiles.map(profile => [profile.id, profile]))
    const grouped = new Map<string, { otherId: string; last: typeof messages[number]; unread: number }>()
    for (const message of messages) {
      const otherId = message.sender_id === user?.id ? message.receiver_id : message.sender_id
      if (!otherId) continue
      const existing = grouped.get(otherId)
      if (existing) { if (message.receiver_id === user?.id && !message.read) existing.unread += 1; continue }
      grouped.set(otherId, { otherId, last: message, unread: message.receiver_id === user?.id && !message.read ? 1 : 0 })
    }
    return [...grouped.values()].map(conversation => ({ ...conversation, profile: profileMap.get(conversation.otherId) }))
  }, [messages, profiles, user?.id])
  return <div className="page-shell"><header className="page-header"><div><p className="section-label">Student communications</p><h1 className="page-title">Messages</h1><p className="page-subtitle">Keep buyer, seller and student conversations inside Campus Plug so transaction context and safety controls stay together.</p></div></header><div className="grid gap-4 lg:grid-cols-[1fr_320px]"><section className="surface overflow-hidden"><div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4"><div className="flex items-center gap-2 font-bold"><MessageCircle size={17} className="text-cyan"/> Conversations</div><span className="text-xs text-white/30">{conversations.length} active</span></div>{isLoading?<div className="space-y-2 p-4">{[1,2,3].map(item=><div key={item} className="skeleton h-20 w-full"/>)}</div>:isError?<div className="p-10 text-center"><MessageCircle className="mx-auto mb-3 text-plug-red/70"/><h2 className="font-bold">Messages could not load</h2><p className="mt-1 text-sm text-white/40">Check your connection and try again.</p></div>:conversations.length===0?<div className="p-10 text-center sm:p-14"><div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-cyan/15 bg-cyan/5"><Search className="text-cyan/70" size={22}/></div><h2 className="font-bold">No conversations yet</h2><p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-white/40">Start a conversation from a marketplace listing or another student. Your messages will appear here automatically.</p><Link to="/marketplace" className="btn-primary mt-5">Browse marketplace <ArrowRight size={15}/></Link></div>:<div className="divide-y divide-white/[0.06]">{conversations.map(({otherId,last,unread,profile})=><Link key={otherId} to={`/workspace?other=${encodeURIComponent(otherId)}${last.transaction_id?`&tx=${encodeURIComponent(last.transaction_id)}`:''}`} className="flex min-h-20 items-center gap-3 px-4 py-3 transition-colors hover:bg-white/[0.025] sm:px-5"><div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-full border border-white/10 bg-white/5 font-bold text-cyan">{profile?.avatar_url?<img src={profile.avatar_url} alt="" className="h-full w-full object-cover"/>:(profile?.full_name?.[0]||'?').toUpperCase()}</div><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-sm font-bold">{profile?.full_name||'Campus Plug student'}</p>{unread>0&&<span className="grid min-w-5 place-items-center rounded-full bg-cyan px-1.5 py-0.5 text-[9px] font-black text-obsidian">{unread>9?'9+':unread}</span>}</div><p className="mt-0.5 truncate text-xs text-white/40">{last.content}</p></div><div className="flex shrink-0 flex-col items-end gap-1"><time className="text-[10px] text-white/25">{new Date(last.created_at).toLocaleDateString('en-NG',{day:'numeric',month:'short'})}</time><ArrowRight size={14} className="text-white/20"/></div></Link>)}</div>}</section><aside className="surface h-fit p-5"><div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-plug-green/20 bg-plug-green/5"><ShieldCheck size={18} className="text-plug-green"/></div><h2 className="font-bold">Stay in-app</h2><p className="mt-2 text-sm leading-6 text-white/40">Marketplace chat uses the existing message security scanner and realtime delivery. Keeping transaction conversations here preserves your safety context.</p></aside></div></div>
}
