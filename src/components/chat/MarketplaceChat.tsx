import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, scanChatMessage } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { scanLive } from '@/lib/chatScanner'
import { Shield, AlertTriangle, Send, Lock, Info, X, Pencil, Check, Trash2, Loader } from 'lucide-react'
import { Database } from '@/types/database'

type Message = Database['public']['Tables']['messages']['Row']
type Profile = Database['public']['Tables']['profiles']['Row']

interface MarketplaceChatProps {
  currentUserId: string
  otherUserId: string
  transactionId?: string
}

interface OptimisticMessage extends Omit<Message, 'id' | 'created_at'> {
  id: string
  created_at: string
  isOptimistic: boolean
  scanStatus: 'pending' | 'safe' | 'flagged' | 'error'
}

interface ChatSecurityWarning {
  show: boolean
  message: string
  severity: 'low' | 'medium' | 'high' | 'critical'
}

const EDIT_WINDOW_MS = 60_000 // 60 seconds

// ── Edit window custom hook ───────────────────────────────────────────────────
function useEditableMessage(message: any) {
  const [canEdit, setCanEdit] = useState(false)
  const [msLeft, setMsLeft] = useState(0)

  useEffect(() => {
    if (!message?.created_at || message.isOptimistic || message.content === '[Message deleted]') return
    
    // Check if the message is a system message (starts with 🔐, 📍, 🚨, ✅)
    const isSystem = message.content?.startsWith('🔐') || 
                     message.content?.startsWith('📍') || 
                     message.content?.startsWith('🚨') || 
                     message.content?.startsWith('✅')
    if (isSystem) return

    const tick = () => {
      const age = Date.now() - new Date(message.created_at).getTime()
      const left = Math.max(0, EDIT_WINDOW_MS - age)
      setMsLeft(left)
      setCanEdit(left > 0)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [message?.created_at, message?.content, message?.isOptimistic])

  return { canEdit, msLeft }
}

// ── System message ────────────────────────────────────────────────────────────
function SystemMessage({ body }: { body: string }) {
  const isDispute = body.includes('Dispute') || body.includes('dispute') || body.includes('🚨')
  const isComplete = body.includes('complete') || body.includes('Released') || body.includes('✅')
  const isLocked = body.includes('locked') || body.includes('🔐')

  const cls = isDispute ? 'border-plug-red/30 bg-plug-red/5 text-plug-red/80'
    : isComplete ? 'border-plug-green/30 bg-plug-green/5 text-plug-green/80'
    : isLocked ? 'border-cyan/30 bg-cyan/5 text-cyan/80'
    : 'border-obsidian-500 bg-obsidian-300 text-white/40'

  return (
    <div className={`mx-auto max-w-xs border rounded-xl px-4 py-2 text-center text-xs font-medium my-2 ${cls}`}>
      {body}
    </div>
  )
}

// ── Trust Guard banner ────────────────────────────────────────────────────────
function TrustGuardWarning({ result, onDismiss }: any) {
  if (!result || result.clean) return null
  const critical = result.blocked
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }}
      className={`mx-4 mb-2 rounded-xl border p-3 ${critical ? 'bg-plug-red/10 border-plug-red/40' : 'bg-plug-amber/8 border-plug-amber/30'}`}>
      <div className="flex items-start gap-2.5">
        <div className="flex-shrink-0 mt-0.5">
          {critical ? <AlertTriangle size={14} className="text-plug-red" /> : <Shield size={14} className="text-plug-amber" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-xs font-bold mb-0.5 ${critical ? 'text-plug-red' : 'text-plug-amber'}`}>
            {critical ? '🚨 Trust Guard: Escrow Protection at Risk' : '⚠️ Trust Guard Warning'}
          </div>
          <div className="text-xs text-white/60 leading-relaxed">{result.message}</div>
          <div className="text-xs text-white/40 mt-1.5 italic">
            Stay in-app to keep your PlugPay protection and PlugScore bonuses active.
          </div>
        </div>
        {!critical && <button onClick={onDismiss} className="flex-shrink-0 text-white/20 hover:text-white/50"><X size={12} /></button>}
      </div>
    </motion.div>
  )
}

// ── Message bubble component ──────────────────────────────────────────────────
interface MessageBubbleProps {
  message: OptimisticMessage
  isOwn: boolean
  onEdit: (msgId: string, newContent: string, originalContent: string) => Promise<void>
  onDelete: (msgId: string, originalContent: string) => Promise<void>
}

function MessageBubble({ message, isOwn, onEdit, onDelete }: MessageBubbleProps) {
  const { canEdit, msLeft } = useEditableMessage(isOwn ? message : null)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(message.content)
  const [saving, setSaving] = useState(false)

  // System message formatting check
  const isSystem = message.content?.startsWith('🔐') || 
                   message.content?.startsWith('📍') || 
                   message.content?.startsWith('🚨') || 
                   message.content?.startsWith('✅')

  if (isSystem) return <SystemMessage body={message.content} />

  const isDeleted = message.content === '[Message deleted]'
  const displayBody = message.content

  const handleSaveEdit = async () => {
    if (!editText.trim() || editText === message.content) { setEditing(false); return }
    setSaving(true)
    await onEdit(message.id, editText.trim(), message.content)
    setSaving(false)
    setEditing(false)
  }

  const editSecs = Math.ceil(msLeft / 1000)

  return (
    <motion.div initial={{ opacity: 0, y: 6, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.15 }}
      className={`flex ${isOwn ? 'justify-end' : 'justify-start'} px-4 mb-1 group`}>
      <div className="max-w-[72%]">
        {editing ? (
          <div className="flex gap-2 items-end">
            <textarea
              className="bg-obsidian-300 border border-cyan/40 rounded-xl px-3 py-2 text-sm text-white resize-none outline-none"
              style={{ fontFamily: 'Lexend, sans-serif' }}
              rows={2} value={editText} onChange={e => setEditText(e.target.value)}
              autoFocus
            />
            <div className="flex flex-col gap-1">
              <button onClick={handleSaveEdit} disabled={saving}
                className="p-1.5 rounded-lg bg-plug-green/20 text-plug-green hover:bg-plug-green/30 disabled:opacity-50">
                <Check size={13} />
              </button>
              <button onClick={() => { setEditing(false); setEditText(message.content) }}
                className="p-1.5 rounded-lg bg-obsidian-300 text-white/40 hover:text-white">
                <X size={13} />
              </button>
            </div>
          </div>
        ) : (
          <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isOwn ? 'bg-cyan text-obsidian rounded-br-sm font-medium'
              : 'bg-obsidian-400 border border-obsidian-500 text-white/90 rounded-bl-sm'
          } ${isDeleted ? 'italic opacity-40' : ''}`}>
            {displayBody}
          </div>
        )}

        <div className={`flex items-center gap-2 mt-0.5 ${isOwn ? 'justify-end' : 'justify-start'}`}>
          <div className="text-[10px] text-white/25">
            {new Date(message.created_at).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
            {isOwn && <span className="ml-1">{message.read ? '✓✓' : '✓'}</span>}
          </div>

          {/* Edit/delete controls (only during 60s window, own messages) */}
          {isOwn && !isDeleted && !editing && !message.isOptimistic && (
            <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
              {canEdit && (
                <button onClick={() => setEditing(true)}
                  className="flex items-center gap-0.5 text-[9px] text-white/30 hover:text-cyan transition-colors px-1.5 py-0.5 rounded-lg hover:bg-cyan/10"
                  title={`Edit (${editSecs}s remaining)`}>
                  <Pencil size={9} /> {editSecs}s
                </button>
              )}
              {canEdit && (
                <button onClick={() => onDelete(message.id, message.content)}
                  className="p-0.5 text-white/20 hover:text-plug-red transition-colors rounded hover:bg-plug-red/10"
                  title="Delete (within 60s)">
                  <Trash2 size={10} />
                </button>
              )}
            </div>
          )}

          {/* Optimistic send status indicators */}
          {message.isOptimistic && (
            <span className={`text-[9px] font-mono ${
              message.scanStatus === 'pending' ? 'text-yellow-400' :
              message.scanStatus === 'flagged' ? 'text-red-400' : 'text-red-400'
            }`}>
              {message.scanStatus === 'pending' && 'SENDING...'}
              {message.scanStatus === 'flagged' && 'FLAGGED'}
              {message.scanStatus === 'error' && 'FAILED'}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  )
}

// ── Date separator ────────────────────────────────────────────────────────────
function DateSep({ date }: { date: string }) {
  const d = new Date(date), today = new Date()
  const diff = Math.floor((today.getTime() - d.getTime()) / 86400000)
  const label = diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString('en-NG', { weekday: 'long', month: 'short', day: 'numeric' })
  return (
    <div className="flex items-center gap-3 px-4 my-3">
      <div className="flex-1 h-px bg-obsidian-500" />
      <span className="text-[10px] text-white/30 font-medium">{label}</span>
      <div className="flex-1 h-px bg-obsidian-500" />
    </div>
  )
}

// ── Main MarketplaceChat Component ─────────────────────────────────────────────
export default function MarketplaceChat({ currentUserId, otherUserId, transactionId }: MarketplaceChatProps) {
  const qc = useQueryClient()
  const { session } = useAuth()
  
  const [messages, setMessages] = useState<OptimisticMessage[]>([])
  const [otherUser, setOtherUser] = useState<Profile | null>(null)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [loading, setLoading] = useState(true)
  
  const [scanResult, setScanResult] = useState<any>(null)
  const [warnDismissed, setWarnDismissed] = useState(false)
  const [securityWarning, setSecurityWarning] = useState<ChatSecurityWarning>({
    show: false,
    message: '',
    severity: 'medium'
  })

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const subscriptionRef = useRef<any>(null)

  useEffect(() => {
    fetchMessages()
    fetchOtherUser()
    setupRealtimeSubscription()
    markMessagesAsRead()

    return () => {
      if (subscriptionRef.current) {
        supabase.removeChannel(subscriptionRef.current)
      }
    }
  }, [currentUserId, otherUserId, transactionId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const fetchMessages = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .or(`and(sender_id.eq.${currentUserId},receiver_id.eq.${otherUserId}),and(sender_id.eq.${otherUserId},receiver_id.eq.${currentUserId})`)
        .order('created_at', { ascending: true })

      if (error) throw error

      setMessages((data || []).map(msg => ({ ...msg, isOptimistic: false, scanStatus: 'safe' as const })))
    } catch (err: any) {
      console.error('Error fetching messages:', err)
    } finally {
      setLoading(false)
    }
  }

  const fetchOtherUser = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', otherUserId)
        .single()

      if (error) throw error
      setOtherUser(data)
    } catch (err: any) {
      console.error('Error fetching chat user profile:', err)
    }
  }

  const setupRealtimeSubscription = () => {
    const subscription = supabase
      .channel(`chat:${[currentUserId, otherUserId].sort().join(':')}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'messages',
        },
        (payload) => {
          const newMsg = payload.new as Message
          if (!newMsg) return
          const relevant = (newMsg.sender_id === currentUserId && newMsg.receiver_id === otherUserId) ||
                           (newMsg.sender_id === otherUserId && newMsg.receiver_id === currentUserId)
          if (!relevant) return

          if (payload.eventType === 'INSERT') {
            setMessages(prev => [
              ...prev.filter(m => m.id !== newMsg.id),
              { ...newMsg, isOptimistic: false, scanStatus: 'safe' as const }
            ])
            if (newMsg.sender_id === otherUserId) {
              supabase.from('messages').update({ read: true }).eq('id', newMsg.id).then()
            }
          } else if (payload.eventType === 'UPDATE') {
            setMessages(prev => prev.map(m => m.id === newMsg.id ? { ...newMsg, isOptimistic: false, scanStatus: 'safe' } : m))
          }
        }
      )
      .subscribe()

    subscriptionRef.current = subscription
  }

  const markMessagesAsRead = async () => {
    try {
      await supabase
        .from('messages')
        .update({ read: true })
        .eq('sender_id', otherUserId)
        .eq('receiver_id', currentUserId)
        .eq('read', false)
    } catch (err) {
      console.error('Error marking messages as read:', err)
    }
  }

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    setWarnDismissed(false)
    setScanResult(val.trim().length > 3 ? scanLive(val) : null)
  }, [])

  const handleSendMessage = async () => {
    const text = input.trim()
    if (!text || sending || scanResult?.blocked) return

    setSending(true)
    setInput('')
    setScanResult(null)
    setSecurityWarning({ show: false, message: '', severity: 'medium' })

    const tempId = `temp-${Date.now()}`
    const optimisticMessage: OptimisticMessage = {
      id: tempId,
      sender_id: currentUserId,
      receiver_id: otherUserId,
      transaction_id: transactionId || undefined,
      content: text,
      read: false,
      message_type: 'text',
      created_at: new Date().toISOString(),
      isOptimistic: true,
      scanStatus: 'pending'
    }

    setMessages(prev => [...prev, optimisticMessage])

    try {
      // 1. Scan message using Edge Function
      const scanResultData = await scanChatMessage(
        tempId,
        currentUserId,
        otherUserId,
        text,
        'marketplace'
      )

      if (scanResultData?.flagged) {
        setSecurityWarning({
          show: true,
          message: `Message blocked: ${scanResultData.flag_type || 'leakage warning'}. Sharing phone numbers or off-platform payment info is prohibited.`,
          severity: 'high'
        })
        setMessages(prev => prev.filter(m => m.id !== tempId))
        setSending(false)
        return
      }

      // 2. Insert message to DB if safe
      const { data, error } = await supabase
        .from('messages')
        .insert({
          sender_id: currentUserId,
          receiver_id: otherUserId,
          transaction_id: transactionId || null,
          content: text,
          message_type: 'text',
        })
        .select()
        .single()

      if (error) throw error

      setMessages(prev => prev.map(m =>
        m.id === tempId ? { ...data, isOptimistic: false, scanStatus: 'safe' } : m
      ))

      markMessagesAsRead()
    } catch (err: any) {
      console.error('Error sending message:', err)
      setMessages(prev => prev.map(m =>
        m.id === tempId ? { ...m, scanStatus: 'error' } : m
      ))
      setSecurityWarning({
        show: true,
        message: 'Failed to send message. Please check connection and try again.',
        severity: 'low'
      })
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }

  // Edit message (within 60s window)
  const handleEdit = async (msgId: string, newContent: string, originalContent: string) => {
    try {
      // Archive original in audit_logs inside metadata object
      await supabase.from('audit_logs').insert({
        entity_type: 'message',
        entity_id: msgId,
        user_id: currentUserId,
        action: 'edit',
        metadata: {
          original_content: originalContent,
          new_content: newContent,
          transaction_id: transactionId || null
        }
      })
      // Update message
      const { error } = await supabase
        .from('messages')
        .update({ content: newContent })
        .eq('id', msgId)
        .eq('sender_id', currentUserId)

      if (error) throw error
    } catch (e) {
      console.error('Failed to edit message:', e)
    }
  }

  // Delete message (within 60s window — soft delete)
  const handleDelete = async (msgId: string, originalContent: string) => {
    if (!window.confirm('Delete this message?')) return
    try {
      // Archive in audit_logs first
      await supabase.from('audit_logs').insert({
        entity_type: 'message',
        entity_id: msgId,
        user_id: currentUserId,
        action: 'delete',
        metadata: {
          original_content: originalContent,
          transaction_id: transactionId || null
        }
      })
      // Soft delete
      const { error } = await supabase
        .from('messages')
        .update({ content: '[Message deleted]' })
        .eq('id', msgId)
        .eq('sender_id', currentUserId)

      if (error) throw error
    } catch (e) {
      console.error('Failed to delete message:', e)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  // Group messages by date
  const grouped = messages.reduce((acc: any, msg: any) => {
    const day = new Date(msg.created_at).toDateString()
    if (!acc[day]) acc[day] = []
    acc[day].push(msg)
    return acc
  }, {})

  const otherUserInitials = otherUser?.username?.slice(0, 2).toUpperCase() || '??'

  return (
    <div className="flex flex-col h-full bg-obsidian-400 rounded-2xl overflow-hidden border border-obsidian-500 font-sans" style={{ fontFamily: 'Lexend, sans-serif' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-obsidian-500 flex-shrink-0 bg-obsidian-400">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-cyan to-purple flex items-center justify-center text-obsidian font-black text-sm flex-shrink-0">
            {otherUser?.avatar_url ? (
              <img src={otherUser.avatar_url} alt="" className="w-full h-full rounded-full object-cover" />
            ) : (
              otherUserInitials
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate text-white">{otherUser?.full_name || otherUser?.username || 'Unknown User'}</div>
            <div className="flex items-center gap-1 text-[10px] text-plug-green font-semibold">
              <Shield size={9} />PlugPay Protected · 60s edit window
            </div>
          </div>
        </div>
        {transactionId && (
          <div className="flex items-center gap-1 text-[10px] text-white/30 font-mono">
            <Lock size={9} />Evidence log
          </div>
        )}
      </div>

      {/* Evidence Notice */}
      {transactionId && (
        <div className="flex items-center gap-2 px-4 py-2 bg-cyan/5 border-b border-cyan/10">
          <Info size={11} className="text-cyan flex-shrink-0" />
          <span className="text-[10px] text-cyan/70">
            Chat linked to transaction {transactionId.slice(0, 8).toUpperCase()}. Messages are preserved as dispute evidence.
          </span>
        </div>
      )}

      {/* Security alert banner from function scan */}
      {securityWarning.show && (
        <div className={`p-3 border-b flex items-start gap-2.5 ${
          securityWarning.severity === 'high' || securityWarning.severity === 'critical'
            ? 'bg-plug-red/10 border-plug-red/40 text-plug-red'
            : 'bg-plug-amber/8 border-plug-amber/30 text-plug-amber'
        }`}>
          {securityWarning.severity === 'high' || securityWarning.severity === 'critical' ? (
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          ) : (
            <Shield size={14} className="mt-0.5 flex-shrink-0" />
          )}
          <div className="flex-1">
            <div className="text-xs font-bold uppercase">Trust Guard Alert</div>
            <div className="text-xs text-white/70 leading-relaxed mt-0.5">{securityWarning.message}</div>
          </div>
          <button onClick={() => setSecurityWarning({ show: false, message: '', severity: 'medium' })}
            className="text-white/20 hover:text-white/50"><X size={12} /></button>
        </div>
      )}

      {/* Messages Viewport */}
      <div className="flex-1 overflow-y-auto py-3 space-y-0.5 bg-obsidian-400/20">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-white/30">
            <Loader size={20} className="animate-spin text-cyan" />
            <span className="text-xs font-mono">LOADING MESSAGES...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="text-center py-12 text-white/30">
            <Shield size={28} className="mx-auto mb-3 opacity-30 text-cyan" />
            <p className="text-sm">Start the conversation</p>
            <p className="text-xs mt-1">Keep communication here to ensure transaction protection.</p>
          </div>
        ) : (
          Object.entries(grouped).map(([day, msgs]: [string, any]) => (
            <div key={day}>
              <DateSep date={msgs[0].created_at} />
              {msgs.map((msg: OptimisticMessage) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  isOwn={msg.sender_id === currentUserId}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                />
              ))}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>

      {/* Trust Guard warning based on client-side scanLive as typing */}
      <AnimatePresence>
        {scanResult && !scanResult.clean && !warnDismissed && (
          <TrustGuardWarning result={scanResult} onDismiss={() => setWarnDismissed(true)} />
        )}
      </AnimatePresence>

      {/* Chat Input controls */}
      <div className="border-t border-obsidian-500 p-3 flex-shrink-0 bg-obsidian-400">
        <div className="flex gap-2 items-end">
          <textarea
            ref={inputRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={scanResult?.blocked ? 'Remove payment/contact details to send...' : 'Type a message...'}
            rows={1}
            disabled={sending}
            className={`flex-1 bg-obsidian-300 border rounded-xl px-4 py-2.5 text-sm text-white
                        placeholder-white/20 resize-none outline-none transition-colors max-h-28
                        ${scanResult?.blocked ? 'border-plug-red/50 focus:border-plug-red/70' : 
                          scanResult ? 'border-plug-amber/40 focus:border-plug-amber/60' : 'border-obsidian-500 focus:border-cyan/50'}`}
            style={{ fontFamily: 'Lexend, sans-serif' }}
          />
          <motion.button 
            onClick={handleSendMessage} 
            disabled={!input.trim() || sending || !!scanResult?.blocked} 
            whileTap={{ scale: 0.92 }}
            className={`p-2.5 rounded-xl transition-all flex-shrink-0 ${
              input.trim() && !scanResult?.blocked ? 'bg-cyan text-obsidian shadow-cyan' : 'bg-obsidian-300 text-white/20 cursor-not-allowed'
            }`}
          >
            <Send size={16} />
          </motion.button>
        </div>
        <div className="text-[10px] text-white/20 mt-1.5 text-center">
          Enter to send · Editable for 60 seconds after sending
        </div>
      </div>
    </div>
  )
}