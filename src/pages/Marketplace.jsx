import { useState, useCallback } from 'react'
import { useSearchParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useDropzone } from 'react-dropzone'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, formatNaira, toKobo, uploadImage } from '@/lib/supabase'
import { analyzeAndStripExif, saveExifFlags, checkPriceFloor, consumeEmergencyToken } from '@/lib/security'
import { useAuth } from '@/contexts/AuthContext'
import { useRealtimeTable } from '@/hooks/useRealtime'
import toast from 'react-hot-toast'
import { Plus, X, Upload, TrendingUp, Search, AlertTriangle, Shield, Zap } from 'lucide-react'

const CATEGORIES = ['Textbooks', 'Electronics', 'Hostels', 'Gadgets', 'Clothing', 'Lab Equipment', 'Other']

// ── Price Floor Warning Banner ────────────────────────────────────────────────
function PriceFloorWarning({ floorData, onUseToken, onAdjust, using }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="bg-plug-red/5 border border-plug-red/30 rounded-xl p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={16} className="text-plug-red flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="font-bold text-sm text-plug-red mb-1">Price Below Market Floor</div>
          <p className="text-xs text-white/60 mb-3">
            Your price is <strong className="text-plug-red">{floorData.below_pct}% below</strong> the
            campus median. Minimum allowed: <strong className="text-white">{formatNaira(floorData.floor_price)}</strong>
          </p>
          <div className="flex gap-2 flex-wrap">
            <button onClick={onAdjust}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-cyan text-obsidian">
              Use {formatNaira(floorData.floor_price)} instead
            </button>
            {floorData.token_available && (
              <button
                onClick={onUseToken}
                disabled={using}
                className="px-3 py-1.5 rounded-lg text-xs font-bold border border-plug-amber/40
                           text-plug-amber hover:bg-plug-amber/10 transition-colors disabled:opacity-50"
              >
                🎟️ Use Emergency Token ({floorData.tokens_remaining} left this month)
              </button>
            )}
            {!floorData.token_available && (
              <span className="text-xs text-white/30 flex items-center gap-1">
                No emergency tokens left this month
              </span>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

// ── EXIF Status Indicator ─────────────────────────────────────────────────────
function ExifStatus({ status }) {
  if (status === 'analyzing') return (
    <div className="flex items-center gap-2 text-xs text-white/40 animate-pulse">
      <div className="w-2 h-2 rounded-full bg-plug-amber" />
      Analyzing image metadata...
    </div>
  )
  if (status === 'clean') return (
    <div className="flex items-center gap-2 text-xs text-plug-green">
      <Shield size={11} />
      Metadata verified — +10 PlugScore on publish
    </div>
  )
  if (status === 'flagged') return (
    <div className="flex items-center gap-2 text-xs text-plug-red">
      <AlertTriangle size={11} />
      Location/timestamp mismatch — listing will be marked "Unverified Source"
    </div>
  )
  return null
}

// ── Create Listing Modal ──────────────────────────────────────────────────────
function CreateListingModal({ onClose, profile }) {
  const qc = useQueryClient()
  const [form, setForm]         = useState({ title: '', description: '', category: '', price: '' })
  const [images, setImages]     = useState([])         // { file, preview, exif }[]
  const [suggestion, setSuggestion] = useState(null)
  const [floorData, setFloorData]   = useState(null)    // price floor result
  const [exifStatus, setExifStatus] = useState(null)    // analyzing | clean | flagged
  const [loadingPrice, setLoadingPrice] = useState(false)
  const [submitting, setSubmitting]     = useState(false)
  const [usingToken, setUsingToken]     = useState(false)
  const [tokenOverride, setTokenOverride] = useState(null)  // emergency_token_id if approved

  const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  // Price change: check floor
  const handlePriceChange = async (e) => {
    const val = e.target.value
    setForm(f => ({ ...f, price: val }))
    setFloorData(null)
    setTokenOverride(null)

    if (!val || !form.category || !profile?.university || !profile?.id) return
    const priceNum = parseFloat(val)
    if (isNaN(priceNum) || priceNum <= 0) return

    const check = await checkPriceFloor(priceNum, form.category, profile.university, profile.id)
    if (!check.allowed && check.floor_price) setFloorData(check)
  }

  const handleUseToken = async () => {
    if (!floorData?.available_token_id) return
    setUsingToken(true)
    // We'll consume the token at listing creation time
    setTokenOverride(floorData.available_token_id)
    setFloorData(null)
    toast.success(`🎟️ Emergency token applied! You can list below floor price.`)
    setUsingToken(false)
  }

  const handleAdjustPrice = () => {
    if (!floorData?.floor_price) return
    setForm(f => ({ ...f, price: (floorData.floor_price / 100).toFixed(0) }))
    setFloorData(null)
    setTokenOverride(null)
  }

  // Category change: fetch price suggestion + floor
  const handleCategoryChange = async (e) => {
    const cat = e.target.value
    setForm(f => ({ ...f, category: cat }))
    if (!cat || !profile?.university) return
    setLoadingPrice(true)
    const { data } = await supabase.rpc('get_price_suggestion', {
      p_category: cat, p_university: profile.university,
    })
    setSuggestion(data)
    setLoadingPrice(false)
  }

  // Image drop: analyze EXIF
  const onDrop = useCallback(async (files) => {
    const newImgs = []
    for (const file of files.slice(0, 4 - images.length)) {
      setExifStatus('analyzing')
      const exif = await analyzeAndStripExif(file, profile?.university)
      newImgs.push({
        file:    exif.clean_blob || file,
        preview: URL.createObjectURL(exif.clean_blob || file),
        exif,
      })
    }
    setImages(prev => [...prev, ...newImgs].slice(0, 4))

    // Determine overall EXIF status from all images
    const allExif = [...images, ...newImgs].map(i => i.exif).filter(Boolean)
    const anyFlagged = allExif.some(e => e.gps_mismatch || e.timestamp_flag)
    setExifStatus(anyFlagged ? 'flagged' : allExif.length > 0 ? 'clean' : null)
  }, [images, profile?.university])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop, accept: { 'image/*': [] }, maxSize: 5 * 1024 * 1024,
  })

  const removeImage = (idx) => {
    setImages(prev => {
      URL.revokeObjectURL(prev[idx].preview)
      const next = prev.filter((_, i) => i !== idx)
      if (!next.length) setExifStatus(null)
      return next
    })
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!form.category) { toast.error('Select a category'); return }

    // Final floor check before submit
    if (floorData && !tokenOverride) {
      toast.error('Price is below the floor. Adjust price or use an emergency token.')
      return
    }

    setSubmitting(true)
    try {
      // Upload clean (EXIF-stripped) images
      const uploadedUrls = await Promise.all(
        images.map(({ file }) => uploadImage(file, 'listings'))
      )

      const { data: listing, error } = await supabase.from('listings').insert({
        seller_id:          profile.id,
        title:              form.title,
        description:        form.description,
        category:           form.category,
        price:              toKobo(form.price),
        images:             uploadedUrls,
        university:         profile.university,
        floor_override:     !!tokenOverride,
        emergency_token_id: tokenOverride || null,
      }).select().single()

      if (error) throw error

      // Consume token if used
      if (tokenOverride) {
        await consumeEmergencyToken(tokenOverride, listing.id)
      }

      // Save EXIF analysis results (triggers PlugScore update in DB)
      for (let i = 0; i < images.length; i++) {
        if (images[i].exif && uploadedUrls[i]) {
          await saveExifFlags(listing.id, uploadedUrls[i], images[i].exif)
        }
      }

      // Activity feed
      await supabase.from('activity_feed').insert({
        actor_name: profile.full_name, actor_id: profile.id,
        action: 'listed a new item', subject: form.title,
        amount: toKobo(form.price), emoji: '🛍️', university: profile.university,
      })

      toast.success('Listing published! 🎉')
      qc.invalidateQueries({ queryKey: ['listings'] })
      qc.invalidateQueries({ queryKey: ['recent-listings'] })
      onClose()
    } catch (err) {
      toast.error(err.message || 'Failed to publish listing')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
         onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 400, damping: 30 }}
        className="relative z-10 w-full max-w-xl bg-obsidian-400 border border-obsidian-500
                   rounded-2xl max-h-[92vh] overflow-y-auto"
      >
        <div className="sticky top-0 bg-obsidian-400 border-b border-obsidian-500 px-6 py-4 flex items-center justify-between">
          <h2 className="font-bold text-lg">List an Item</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-obsidian-300 rounded-lg text-white/40 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          <div>
            <label className="label">Title</label>
            <input className="input" placeholder="e.g. Stryer's Biochemistry 8th Edition"
              value={form.title} onChange={set('title')} required maxLength={100} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">Category</label>
              <select className="input" value={form.category} onChange={handleCategoryChange} required>
                <option value="">Select category</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Price (₦)</label>
              <input className="input" type="number" placeholder="0.00" min="1"
                value={form.price} onChange={handlePriceChange} required />
            </div>
          </div>

          {/* Price Floor Warning */}
          <AnimatePresence>
            {floorData && !tokenOverride && (
              <PriceFloorWarning
                floorData={floorData}
                onUseToken={handleUseToken}
                onAdjust={handleAdjustPrice}
                using={usingToken}
              />
            )}
          </AnimatePresence>

          {tokenOverride && (
            <div className="flex items-center gap-2 text-xs text-plug-amber">
              <Zap size={12} />
              Emergency token applied — below-floor price allowed
            </div>
          )}

          {/* Smart Price Suggestion */}
          {(loadingPrice || suggestion) && !floorData && (
            <div className="bg-plug-green/5 border border-plug-green/20 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp size={13} className="text-plug-green" />
                <span className="text-xs font-bold text-plug-green uppercase tracking-wider">
                  Smart Price (IQR-cleaned)
                </span>
              </div>
              {loadingPrice ? (
                <div className="text-sm text-white/40 animate-pulse">Analyzing campus prices...</div>
              ) : suggestion?.sample_count > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="text-xl font-black text-plug-green font-mono">
                        {formatNaira(suggestion.median_price)}
                      </div>
                      <div className="text-xs text-white/40">Recommended median
                        {suggestion.outliers_removed > 0 && ` (${suggestion.outliers_removed} outliers excluded)`}
                      </div>
                    </div>
                    <button type="button"
                      onClick={() => setForm(f => ({ ...f, price: (suggestion.median_price / 100).toFixed(0) }))}
                      className="text-xs bg-plug-green/20 text-plug-green px-3 py-1.5 rounded-lg
                                 hover:bg-plug-green/30 transition-colors font-semibold">
                      Use This Price
                    </button>
                  </div>
                  <div className="flex gap-3 text-xs text-white/40">
                    <span>Min: {formatNaira(suggestion.min_price)}</span>
                    <span>Max: {formatNaira(suggestion.max_price)}</span>
                    <span>{suggestion.sample_count} listings analyzed</span>
                  </div>
                  <div className="relative h-1.5 bg-obsidian-300 rounded-full">
                    <div className="absolute h-full rounded-full bg-gradient-to-r from-cyan to-purple"
                      style={{ width: suggestion.max_price > 0 ? `${Math.min(suggestion.median_price / suggestion.max_price * 100, 100)}%` : '50%' }} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-white/40">No comparable listings yet. Set any price.</p>
              )}
            </div>
          )}

          <div>
            <label className="label">Description</label>
            <textarea className="input resize-none" rows={3}
              placeholder="Condition, edition, accessories included..."
              value={form.description} onChange={set('description')} />
          </div>

          {/* Image Upload with EXIF analysis */}
          <div>
            <label className="label">Photos (up to 4) — EXIF auto-stripped</label>
            <div {...getRootProps()}
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                isDragActive ? 'border-cyan bg-cyan/5' : 'border-obsidian-500 hover:border-cyan/40 hover:bg-obsidian-300/30'
              }`}>
              <input {...getInputProps()} />
              <Upload size={22} className="mx-auto text-white/30 mb-2" />
              <p className="text-sm text-white/40">{isDragActive ? 'Drop here' : 'Drag & drop or click'}</p>
              <p className="text-xs text-white/25 mt-1">GPS data stripped automatically. Location verified for trust badge.</p>
            </div>

            {exifStatus && (
              <div className="mt-2">
                <ExifStatus status={exifStatus} />
              </div>
            )}

            {images.length > 0 && (
              <div className="flex gap-2 mt-3 flex-wrap">
                {images.map((img, i) => (
                  <div key={i} className="relative">
                    <img src={img.preview} alt=""
                      className={`w-20 h-20 rounded-lg object-cover border-2 ${
                        img.exif?.gps_mismatch || img.exif?.timestamp_flag
                          ? 'border-plug-red/50' : 'border-obsidian-500'
                      }`} />
                    {img.exif && !img.exif.gps_mismatch && !img.exif.timestamp_flag && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-plug-green
                                      flex items-center justify-center text-[8px] text-obsidian font-bold">✓</div>
                    )}
                    {(img.exif?.gps_mismatch || img.exif?.timestamp_flag) && (
                      <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-plug-red
                                      flex items-center justify-center text-[8px] text-white">!</div>
                    )}
                    <button type="button" onClick={() => removeImage(i)}
                      className="absolute -bottom-1 -left-1 w-4 h-4 rounded-full bg-obsidian border border-obsidian-500
                                 text-white/60 flex items-center justify-center text-[10px]">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button type="submit" disabled={submitting || (!!floorData && !tokenOverride)}
            className="btn-primary w-full disabled:opacity-40 disabled:cursor-not-allowed">
            {submitting ? 'Publishing...' : 'Publish Listing'}
          </button>
        </form>
      </motion.div>
    </div>
  )
}

// ── Listing Card ──────────────────────────────────────────────────────────────
function ListingCard({ listing }) {
  return (
    <Link to={`/marketplace/${listing.id}`}
      className="bg-obsidian-400 border border-obsidian-500 rounded-xl overflow-hidden
                 hover:border-cyan/30 hover:-translate-y-1 transition-all duration-200 group">
      <div className="aspect-video bg-obsidian-300 overflow-hidden relative">
        {listing.images?.[0]
          ? <img src={listing.images[0]} alt={listing.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
          : <div className="w-full h-full flex items-center justify-center text-4xl">📦</div>
        }
        {listing.metadata_verified && (
          <div className="absolute top-2 left-2 flex items-center gap-1 bg-plug-green/90 text-obsidian
                          text-[9px] font-bold px-1.5 py-0.5 rounded-full">
            <Shield size={8} /> VERIFIED
          </div>
        )}
        {listing.exif_flagged && (
          <div className="absolute top-2 left-2 flex items-center gap-1 bg-plug-red/90 text-white
                          text-[9px] font-bold px-1.5 py-0.5 rounded-full">
            <AlertTriangle size={8} /> UNVERIFIED SOURCE
          </div>
        )}
        {listing.floor_override && (
          <div className="absolute top-2 right-2 flex items-center gap-1 bg-plug-amber/90 text-obsidian
                          text-[9px] font-bold px-1.5 py-0.5 rounded-full">
            🎟️ SALE
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-start justify-between gap-2 mb-2">
          <h3 className="font-semibold text-sm leading-snug line-clamp-2 group-hover:text-cyan transition-colors">
            {listing.title}
          </h3>
          <span className="font-mono font-black text-cyan text-sm flex-shrink-0">
            {formatNaira(listing.price)}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="tag tag-cyan text-[10px]">{listing.category}</span>
          <span className="text-xs text-white/30">{listing.profiles?.full_name?.split(' ')[0]}</span>
        </div>
      </div>
    </Link>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function Marketplace() {
  const { profile } = useAuth()
  const [searchParams] = useSearchParams()
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(searchParams.get('action') === 'create')
  const [search, setSearch]         = useState('')
  const [category, setCategory]     = useState(searchParams.get('cat') || '')
  const [myOnly, setMyOnly]         = useState(searchParams.get('tab') === 'my-listings')
  const [verifiedOnly, setVerifiedOnly] = useState(false)

  const { data: listings = [], isLoading } = useQuery({
    queryKey: ['listings', category, myOnly, verifiedOnly, profile?.id],
    queryFn: async () => {
      let q = supabase
        .from('listings')
        .select('*, profiles(full_name, university, avatar_url)')
        .eq('status', 'active')
        .order('created_at', { ascending: false })

      if (category)      q = q.eq('category', category)
      if (myOnly)        q = q.eq('seller_id', profile?.id)
      if (verifiedOnly)  q = q.eq('metadata_verified', true)

      const { data, error } = await q
      if (error) throw error
      return data || []
    },
  })

  useRealtimeTable({
    table: 'listings',
    onInsert: (l) => {
      if (myOnly && l.seller_id !== profile?.id) return
      if (category && l.category !== category) return
      qc.setQueryData(['listings', category, myOnly, verifiedOnly, profile?.id],
        old => [l, ...(old || [])])
    },
    onUpdate: (u) => {
      qc.setQueryData(['listings', category, myOnly, verifiedOnly, profile?.id],
        old => (old || []).map(l => l.id === u.id ? { ...l, ...u } : l))
    },
  })

  const filtered = listings.filter(l =>
    !search || l.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <p className="section-label">P2P Exchange</p>
          <h1 className="text-2xl font-black tracking-tight">Marketplace</h1>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary flex items-center gap-2 self-start">
          <Plus size={16} /> List Item
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 mb-5">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input className="input pl-9" placeholder="Search listings..."
            value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <select className="input sm:w-44" value={category} onChange={e => setCategory(e.target.value)}>
          <option value="">All Categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {/* Filter pills */}
      <div className="flex gap-2 flex-wrap mb-6">
        {['', ...CATEGORIES].map(c => (
          <button key={c || 'all'} onClick={() => setCategory(c)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
              category === c ? 'bg-cyan text-obsidian border-cyan' : 'bg-obsidian-400 text-white/50 border-obsidian-500 hover:border-cyan/30'
            }`}>
            {c || 'All'}
          </button>
        ))}
        <button onClick={() => setMyOnly(v => !v)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all ${
            myOnly ? 'bg-cyan text-obsidian border-cyan' : 'bg-obsidian-400 text-white/50 border-obsidian-500 hover:border-cyan/30'
          }`}>
          My Listings
        </button>
        <button onClick={() => setVerifiedOnly(v => !v)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all flex items-center gap-1 ${
            verifiedOnly ? 'bg-plug-green text-obsidian border-plug-green' : 'bg-obsidian-400 text-white/50 border-obsidian-500 hover:border-plug-green/30'
          }`}>
          <Shield size={10} /> Verified Only
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="bg-obsidian-400 border border-obsidian-500 rounded-xl overflow-hidden animate-pulse">
              <div className="aspect-video bg-obsidian-300" />
              <div className="p-4 space-y-2">
                <div className="h-4 bg-obsidian-300 rounded" />
                <div className="h-3 bg-obsidian-300 rounded w-2/3" />
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-white/30">
          <div className="text-4xl mb-4">🛍️</div>
          <p className="font-semibold">No listings found</p>
          <p className="text-sm mt-1">{myOnly ? "You haven't listed anything yet." : 'Try a different filter.'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map(l => <ListingCard key={l.id} listing={l} />)}
        </div>
      )}

      <AnimatePresence>
        {showCreate && (
          <CreateListingModal onClose={() => setShowCreate(false)} profile={profile} />
        )}
      </AnimatePresence>
    </div>
  )
}
