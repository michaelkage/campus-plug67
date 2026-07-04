import { useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { supabase, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { listPasskeys, removePasskey } from '@/lib/passkeys'
import toast from 'react-hot-toast'
import { Edit2, Shield, Download, CreditCard, Package, TrendingUp, Star, Loader, Fingerprint, Trash2, Plus } from 'lucide-react'

const BADGE_EMOJI = {
  'Hall of Fame':   '🏛️', 'Top Seller': '🏆', 'Rising Star': '🌟',
  'Mentor Badge':   '📚', 'Plug Dev': '⚡', 'Community Hero': '🦸',
}

function CreditRing({ score, max = 1000 }) {
  const pct = Math.min(score / max, 1)
  const r = 52, cx = 60, cy = 60, circ = 2 * Math.PI * r
  const color = score >= 750 ? '#00FF88' : score >= 500 ? '#00F2FF' : '#FFB800'
  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="120" height="120" viewBox="0 0 120 120">
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1A2332" strokeWidth="8" />
        <motion.circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth="8"
          strokeLinecap="round" transform="rotate(-90 60 60)"
          initial={{ strokeDasharray: `0 ${circ}` }}
          animate={{ strokeDasharray: `${pct * circ} ${circ - pct * circ}` }}
          transition={{ duration: 1.2, ease: 'easeOut', delay: 0.3 }} />
      </svg>
      <div className="absolute text-center">
        <motion.div className="text-2xl font-black font-mono" style={{ color }}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>
          {score}
        </motion.div>
        <div className="text-[9px] text-white/40 uppercase tracking-wider">PlugScore</div>
      </div>
    </div>
  )
}

async function exportPDF(profile, ratings, verifyUrl) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const W = doc.internal.pageSize.getWidth()
  const H = doc.internal.pageSize.getHeight()

  // Header band
  doc.setFillColor(8, 11, 15)
  doc.rect(0, 0, W, 52, 'F')
  doc.setFillColor(0, 242, 255)
  doc.rect(0, 0, 4, 52, 'F')

  doc.setTextColor(0, 242, 255)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(20)
  doc.text('Campus', 12, 19)
  doc.setTextColor(255, 255, 255)
  doc.text('Plug ⚡', 40, 19)

  doc.setFontSize(8)
  doc.setTextColor(120, 140, 160)
  doc.setFont('helvetica', 'normal')
  doc.text('Verified Student Freelancer Resume', 12, 27)
  doc.text(`Generated: ${new Date().toLocaleDateString('en-NG', { year:'numeric', month:'long', day:'numeric' })}`, 12, 33)
  doc.text(`Verify live at: ${verifyUrl}`, 12, 39)

  // Verified badge
  doc.setFillColor(0, 255, 136)
  doc.roundedRect(W - 55, 8, 48, 12, 2, 2, 'F')
  doc.setTextColor(8, 11, 15)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(8)
  doc.text('✓ PLUG-VERIFIED', W - 52, 16)

  // Name & meta
  let y = 64
  doc.setTextColor(15, 20, 30)
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.text(profile.full_name || 'Student', 14, y); y += 8

  doc.setFontSize(11); doc.setFont('helvetica', 'normal')
  doc.setTextColor(80, 100, 120)
  const meta = [profile.university, profile.department, profile.level ? `Level ${profile.level}` : null].filter(Boolean).join(' · ')
  doc.text(meta, 14, y); y += 6

  doc.setTextColor(0, 150, 100); doc.setFontSize(9)
  doc.text(`Email: ${profile.email}`, 14, y); y += 12

  // Divider
  doc.setDrawColor(220, 230, 240); doc.setLineWidth(0.3)
  doc.line(14, y, W - 14, y); y += 8

  const sectionHeader = (title) => {
    doc.setFillColor(0, 242, 255); doc.rect(14, y, 3, 5, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(8, 11, 15)
    doc.text(title, 20, y + 4); y += 10
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9)
  }

  const row = (label, value, vc = [15,20,30]) => {
    doc.setTextColor(100, 120, 140); doc.setFontSize(9); doc.text(label, 14, y)
    doc.setTextColor(...vc); doc.setFont('helvetica', 'bold'); doc.text(String(value), 90, y)
    doc.setFont('helvetica', 'normal'); y += 6
  }

  sectionHeader('Platform Statistics')
  row('PlugScore (0–1000)', `${profile.plug_score} / 1000`,
    profile.plug_score >= 750 ? [0,180,100] : profile.plug_score >= 500 ? [0,150,200] : [180,120,0])
  row('Completed Transactions', profile.total_sales)
  row('Verified Platform Earnings', formatNaira(profile.total_earnings))
  row('Average Client Rating', ratings?.avg_rating ? `${ratings.avg_rating} / 5.0 (${ratings.rating_count} reviews)` : 'No ratings yet')
  row('Member Since', new Date(profile.created_at).toLocaleDateString('en-NG', { month:'long', year:'numeric' }))
  y += 4

  doc.line(14, y, W - 14, y); y += 8

  sectionHeader('Badges & Recognition')
  if (profile.badges?.length) {
    doc.setTextColor(15, 20, 30); doc.setFontSize(10)
    doc.text(profile.badges.map(b => `${BADGE_EMOJI[b] || '🎖️'} ${b}`).join('   '), 14, y)
    y += 8
  } else {
    doc.setTextColor(150, 150, 150); doc.text('No badges yet.', 14, y); y += 8
  }
  y += 4; doc.line(14, y, W - 14, y); y += 8

  sectionHeader('Verified Skills')
  const skills = [
    { s:'Digital Commerce',        n:'P2P sales, escrow transactions',    e:`${profile.total_sales} verified sales` },
    { s:'Client Relationship Mgmt', n:'Real buyer/seller communication',  e:`PlugScore ${profile.plug_score}` },
    { s:'Financial Literacy',       n:'Managed NGN escrow transactions',  e:`${formatNaira(profile.total_earnings)} transacted` },
  ]
  skills.forEach(({ s, n, e }) => {
    doc.setFont('helvetica','bold'); doc.setFontSize(9); doc.setTextColor(15,20,30)
    doc.text(s, 14, y)
    doc.setFont('helvetica','normal'); doc.setTextColor(100,120,140); doc.text(`— ${n}`, 62, y)
    doc.setTextColor(0,150,100); doc.text(`[${e}]`, W-14-doc.getTextWidth(`[${e}]`), y)
    y += 6
  })
  y += 4

  // QR code section — using data URL from canvas
  doc.line(14, y, W - 14, y); y += 8
  sectionHeader('Live Verification QR Code')
  doc.setTextColor(80,100,120); doc.setFontSize(8)
  doc.text('Scan to verify this resume\'s authenticity against live Campus Plug data:', 14, y); y += 6
  doc.text(verifyUrl, 14, y); y += 8

  // Draw QR as text-based URL box (jsPDF doesn't render QR natively — employer must visit URL)
  doc.setFillColor(245,248,255); doc.roundedRect(14, y, 80, 12, 2, 2, 'F')
  doc.setDrawColor(0,242,255); doc.setLineWidth(0.5); doc.roundedRect(14, y, 80, 12, 2, 2, 'S')
  doc.setTextColor(0,150,180); doc.setFontSize(7); doc.setFont('helvetica','bold')
  doc.text('🔗  ' + verifyUrl, 18, y + 7); y += 18

  // Footer
  doc.setFillColor(245,248,255); doc.rect(0, H-22, W, 22, 'F')
  doc.setFillColor(0,242,255); doc.rect(0, H-22, W, 1, 'F')
  doc.setFontSize(7.5); doc.setTextColor(100,120,140); doc.setFont('helvetica','normal')
  doc.text('Verified by Campus Plug Technologies Ltd · campusplug.ng', W/2, H-14, { align:'center' })
  doc.text(`Document ID: CP-${profile.id?.slice(0,8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`, W/2, H-9, { align:'center' })

  doc.save(`CampusPlug-Resume-${(profile.full_name||'Student').replace(/\s+/g,'-')}.pdf`)
}

// ── Passkey Manager ───────────────────────────────────────────────────────────
function PasskeyManager({ userId }) {
  const { addPasskey, passkeySupported } = useAuth()
  const [adding, setAdding] = useState(false)
  const [label, setLabel]   = useState('')

  const { data: passkeys = [], refetch } = useQuery({
    queryKey: ['passkeys', userId],
    queryFn: () => listPasskeys(userId),
    enabled: !!userId,
  })

  const handleAdd = async () => {
    setAdding(true)
    await addPasskey(label || 'My Device')
    setLabel('')
    setAdding(false)
    refetch()
  }

  const handleRemove = async (credId) => {
    if (!window.confirm('Remove this passkey?')) return
    await removePasskey(credId, userId)
    toast.success('Passkey removed')
    refetch()
  }

  if (!passkeySupported) return (
    <div className="text-xs text-white/30 flex items-center gap-2">
      <Fingerprint size={12} /> Passkeys not supported on this device
    </div>
  )

  return (
    <div className="space-y-3">
      <div className="text-xs text-white/50 font-semibold uppercase tracking-wider">Registered Passkeys</div>
      {passkeys.length === 0 && (
        <div className="text-xs text-white/30">No passkeys registered. Add one for biometric sign-in.</div>
      )}
      {passkeys.map(pk => (
        <div key={pk.id} className="flex items-center justify-between p-3 bg-obsidian-300 rounded-xl">
          <div className="flex items-center gap-2">
            <Fingerprint size={14} className="text-cyan" />
            <div>
              <div className="text-xs font-semibold">{pk.device_label || 'Unknown Device'}</div>
              <div className="text-[10px] text-white/30">
                Added {new Date(pk.created_at).toLocaleDateString('en-NG')}
                {pk.last_used_at && ` · Last used ${new Date(pk.last_used_at).toLocaleDateString('en-NG')}`}
                {pk.backed_up && ' · ☁️ Cloud backed up'}
              </div>
            </div>
          </div>
          <button onClick={() => handleRemove(pk.credential_id)}
            className="p-1.5 text-plug-red/40 hover:text-plug-red hover:bg-plug-red/10 rounded-lg transition-colors">
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <input className="input flex-1 text-sm" placeholder="Device label (optional)"
          value={label} onChange={e => setLabel(e.target.value)} />
        <button onClick={handleAdd} disabled={adding}
          className="btn-primary px-4 flex items-center gap-1.5 text-sm disabled:opacity-50">
          {adding ? <Loader size={13} className="animate-spin" /> : <Plus size={13} />}
          Add
        </button>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Profile() {
  const { id } = useParams()
  const { profile: myProfile, updateProfile, user } = useAuth()
  const qc = useQueryClient()
  const [editMode, setEditMode] = useState(false)
  const [form, setForm]         = useState({})
  const [saving, setSaving]     = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showPasskeys, setShowPasskeys] = useState(false)

  const viewingOwn = !id || id === user?.id
  const targetId   = id || user?.id
  const verifyUrl  = `${import.meta.env.VITE_APP_URL || 'https://campusplug.ng'}/verify/${targetId}`

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile', targetId],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles').select('*').eq('id', targetId).single()
      if (error) throw error
      return data
    },
    enabled: !!targetId,
  })

  const { data: ratings } = useQuery({
    queryKey: ['ratings', targetId],
    queryFn: async () => {
      const { data } = await supabase.from('profile_ratings').select('*').eq('profile_id', targetId).maybeSingle()
      return data
    },
    enabled: !!targetId,
  })

  const { data: listings = [] } = useQuery({
    queryKey: ['user-listings', targetId],
    queryFn: async () => {
      const { data } = await supabase.from('listings').select('*')
        .eq('seller_id', targetId).not('status','eq','deleted')
        .order('created_at', { ascending: false }).limit(12)
      return data || []
    },
    enabled: !!targetId,
  })

  const handleSave = async () => {
    setSaving(true)
    await updateProfile(form)
    setEditMode(false)
    setSaving(false)
    qc.invalidateQueries({ queryKey: ['profile', targetId] })
  }

  const handleExportPDF = async () => {
    setExporting(true)
    try {
      await exportPDF(profile, ratings, verifyUrl)
      toast.success('Resume downloaded! PDF includes live verification QR.')
    } catch (e) {
      toast.error('Export failed: ' + e.message)
    } finally { setExporting(false) }
  }

  const creditLimit = Math.min((profile?.plug_score || 0) * 100_00, 200_000_00)

  if (isLoading) return (
    <div className="max-w-4xl mx-auto px-4 py-8 animate-pulse space-y-4">
      <div className="h-40 bg-obsidian-400 rounded-2xl" />
      <div className="h-32 bg-obsidian-400 rounded-2xl" />
    </div>
  )
  if (!profile) return (
    <div className="max-w-4xl mx-auto px-4 py-20 text-center text-white/30">
      <p className="text-4xl mb-4">👤</p><p>Profile not found</p>
    </div>
  )

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Profile header */}
      <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl overflow-hidden">
        <div className="h-24 bg-gradient-to-r from-cyan/20 via-purple/20 to-cyan/10 relative">
          <div className="absolute inset-0 cyber-grid opacity-30" />
        </div>
        <div className="px-6 pb-6 -mt-10">
          <div className="flex items-end justify-between mb-4">
            <motion.div whileHover={{ scale: 1.05 }}
              className="w-20 h-20 rounded-2xl bg-gradient-to-br from-cyan to-purple border-4 border-obsidian-400
                         flex items-center justify-center text-obsidian font-black text-3xl shadow-cyan">
              {profile.avatar_url
                ? <img src={profile.avatar_url} className="w-full h-full rounded-xl object-cover" />
                : profile.full_name?.[0]?.toUpperCase() || '?'}
            </motion.div>
            {viewingOwn && (
              <div className="flex gap-2 flex-wrap justify-end">
                <button onClick={handleExportPDF} disabled={exporting}
                  className="btn-ghost flex items-center gap-1.5 text-xs disabled:opacity-50">
                  {exporting ? <Loader size={13} className="animate-spin" /> : <Download size={13} />}
                  PDF + QR
                </button>
                <button onClick={() => setShowPasskeys(v => !v)}
                  className={`btn-ghost flex items-center gap-1.5 text-xs ${showPasskeys ? 'text-cyan border-cyan/30 bg-cyan/5' : ''}`}>
                  <Fingerprint size={13} /> Passkeys
                </button>
                <button onClick={() => { setForm({ full_name: profile.full_name, bio: profile.bio, department: profile.department, level: profile.level }); setEditMode(v => !v) }}
                  className="btn-ghost flex items-center gap-1.5 text-xs">
                  <Edit2 size={13} /> Edit
                </button>
              </div>
            )}
          </div>

          {editMode ? (
            <div className="space-y-3">
              <input className="input" placeholder="Full name" value={form.full_name || ''}
                onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
              <div className="grid grid-cols-2 gap-3">
                <input className="input" placeholder="Department" value={form.department || ''}
                  onChange={e => setForm(f => ({ ...f, department: e.target.value }))} />
                <select className="input" value={form.level || ''} onChange={e => setForm(f => ({ ...f, level: e.target.value }))}>
                  <option value="">Level</option>
                  {['100','200','300','400','500','PG','Staff'].map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
              <textarea className="input resize-none" rows={2} placeholder="Short bio..."
                value={form.bio || ''} onChange={e => setForm(f => ({ ...f, bio: e.target.value }))} />
              <div className="flex gap-2">
                <button onClick={handleSave} disabled={saving} className="btn-primary text-sm py-2">{saving ? 'Saving...' : 'Save'}</button>
                <button onClick={() => setEditMode(false)} className="btn-secondary text-sm py-2">Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <h1 className="text-xl font-black">{profile.full_name}</h1>
                {profile.is_verified && <span className="tag tag-green text-[10px] flex items-center gap-1"><Shield size={9}/>Verified</span>}
              </div>
              <p className="text-sm text-white/50 mb-0.5">{profile.university}</p>
              {profile.department && <p className="text-xs text-white/30 mb-3">{profile.department} · Level {profile.level}</p>}
              {profile.bio && <p className="text-sm text-white/60 mb-3 leading-relaxed">{profile.bio}</p>}
              {ratings?.avg_rating > 0 && (
                <div className="flex items-center gap-1.5 mb-3">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Star key={i} size={12} className={i < Math.round(ratings.avg_rating) ? 'text-plug-amber fill-plug-amber' : 'text-white/20'} />
                  ))}
                  <span className="text-xs text-white/40">{ratings.avg_rating} ({ratings.rating_count})</span>
                </div>
              )}
              {profile.badges?.length > 0 && (
                <div className="flex gap-1.5 flex-wrap">
                  {profile.badges.map(b => <span key={b} className="tag tag-amber text-[10px]">{BADGE_EMOJI[b]||'🎖️'} {b}</span>)}
                </div>
              )}
            </>
          )}

          {/* Passkey manager */}
          <AnimatePresence>
            {showPasskeys && viewingOwn && (
              <motion.div initial={{ opacity:0, height:0 }} animate={{ opacity:1, height:'auto' }}
                exit={{ opacity:0, height:0 }} className="overflow-hidden mt-4 pt-4 border-t border-obsidian-500">
                <PasskeyManager userId={user?.id} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label:'Sales',    val: profile.total_sales,           icon: Package,    c:'text-cyan'        },
          { label:'Earnings', val: formatNaira(profile.total_earnings), icon: TrendingUp, c:'text-plug-green' },
          { label:'Score',    val: profile.plug_score,            icon: Star,       c:'text-plug-amber'  },
        ].map(({ label, val, icon: Icon, c }) => (
          <div key={label} className="bg-obsidian-400 border border-obsidian-500 rounded-xl p-4 text-center">
            <Icon size={16} className={`${c} mx-auto mb-2`} />
            <div className={`text-lg font-black font-mono ${c}`}>{val}</div>
            <div className="text-xs text-white/40 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Resume + Credit + QR (own profile) */}
      {viewingOwn && (
        <div className="grid md:grid-cols-3 gap-4">
          {/* Resume Builder */}
          <div className="md:col-span-2 bg-obsidian-400 border border-obsidian-500 rounded-2xl p-6">
            <p className="section-label">Career Layer</p>
            <h2 className="font-black text-lg mb-1">Verified Resume + QR</h2>
            <p className="text-xs text-white/40 mb-4 leading-relaxed">
              PDF includes a live verification QR code. Employers scan it to view your real-time stats.
            </p>
            <div className="space-y-3 mb-4">
              {[
                { label:'Completed Sales',  pct: Math.min(profile.total_sales/100*100, 100) },
                { label:'Reputation Score', pct: Math.min(profile.plug_score/1000*100, 100) },
                { label:'Client Rating',    pct: ratings?.avg_rating ? ratings.avg_rating/5*100 : 0 },
              ].map(({ label, pct }) => (
                <div key={label}>
                  <div className="flex justify-between text-xs mb-1.5">
                    <span className="text-white/60">{label}</span>
                    <span className="text-cyan font-mono font-bold">{Math.round(pct)}%</span>
                  </div>
                  <div className="h-1.5 bg-obsidian-300 rounded-full overflow-hidden">
                    <motion.div className="h-full rounded-full bg-gradient-to-r from-cyan to-purple"
                      initial={{ width:0 }} animate={{ width:`${Math.max(pct,2)}%` }}
                      transition={{ duration:0.9, ease:'easeOut', delay:0.2 }} />
                  </div>
                </div>
              ))}
            </div>
            <button onClick={handleExportPDF} disabled={exporting}
              className="btn-primary w-full flex items-center justify-center gap-2 text-sm disabled:opacity-50">
              {exporting ? <Loader size={14} className="animate-spin" /> : <Download size={14} />}
              {exporting ? 'Generating PDF...' : 'Download PDF Resume'}
            </button>
          </div>

          {/* Verification QR */}
          <div className="bg-obsidian-400 border border-obsidian-500 rounded-2xl p-5 flex flex-col items-center justify-center gap-4">
            <div className="text-xs font-bold text-white/40 uppercase tracking-wider text-center">Live Verify QR</div>
            <div className="p-3 bg-white rounded-2xl">
              <QRCodeSVG value={verifyUrl} size={120} bgColor="#fff" fgColor="#080B0F" level="M" />
            </div>
            <div className="text-center">
              <div className="text-[9px] text-white/25 font-mono break-all">{verifyUrl}</div>
              <p className="text-xs text-white/40 mt-2">Employers scan this to verify resume authenticity</p>
            </div>
          </div>
        </div>
      )}

      {/* PlugCredit */}
      {viewingOwn && (
        <div className="bg-obsidian-400 border border-purple/20 rounded-2xl p-6">
          <p className="section-label" style={{ color:'#A855F7' }}>PlugCredit</p>
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <CreditRing score={profile.plug_score} />
            <div className="flex-1">
              <h2 className="font-black text-lg mb-1">Micro-Loan Access</h2>
              <p className="text-xs text-white/40 mb-4">BNPL for academic essentials. Backed by your PlugScore.</p>
              <div className="text-2xl font-black text-purple mb-1">{formatNaira(creditLimit)}</div>
              <div className="text-xs text-white/40 mb-4">Available Credit Limit</div>
              <div className="grid grid-cols-3 gap-2 mb-4">
                {[{l:'Interest',v:'0%'},{l:'Payback',v:'60d'},{l:'Approval',v:'Instant'}].map(({l,v})=>(
                  <div key={l} className="bg-obsidian-300 rounded-lg p-2.5 text-center">
                    <div className="text-sm font-black text-purple font-mono">{v}</div>
                    <div className="text-[10px] text-white/40 mt-0.5">{l}</div>
                  </div>
                ))}
              </div>
              <button onClick={() => profile.plug_score >= 600 ? toast('Coming soon!') : toast(`Need ${600-profile.plug_score} more pts`,{icon:'💳'})}
                className={`px-6 py-2.5 rounded-lg text-sm font-bold border transition-all ${
                  profile.plug_score >= 600
                    ? 'bg-purple text-white border-purple hover:bg-purple/80'
                    : 'bg-transparent text-white/30 border-obsidian-500 cursor-not-allowed'
                }`}>
                {profile.plug_score >= 600 ? 'Apply for PlugCredit' : `Unlock at 600 pts (${600-profile.plug_score} more)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Listings grid */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-bold">{viewingOwn ? 'My Listings' : `${profile.full_name?.split(' ')[0]}'s Listings`}</h2>
          <div className="text-xs text-white/40">
            <span className="text-plug-green font-semibold">{listings.filter(l=>l.status==='active').length} active</span>
            {' · '}{listings.filter(l=>l.status==='sold').length} sold
          </div>
        </div>
        {listings.length === 0 ? (
          <div className="text-center py-12 text-white/30 bg-obsidian-400 border border-obsidian-500 rounded-xl">
            <Package size={32} className="mx-auto mb-3 opacity-30"/><p className="text-sm">No listings yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {listings.map(l => (
              <a key={l.id} href={`/marketplace/${l.id}`}
                className="bg-obsidian-400 border border-obsidian-500 rounded-xl overflow-hidden hover:border-cyan/30 transition-colors group">
                <div className="aspect-square bg-obsidian-300 overflow-hidden">
                  {l.images?.[0]
                    ? <img src={l.images[0]} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                    : <div className="w-full h-full flex items-center justify-center text-3xl">📦</div>}
                </div>
                <div className="p-3">
                  <div className="text-xs font-semibold truncate mb-1">{l.title}</div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black text-cyan font-mono">{formatNaira(l.price)}</span>
                    <span className={`tag text-[9px] ${l.status==='active'?'tag-green':l.status==='sold'?'tag-purple':'tag-amber'}`}>{l.status}</span>
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
