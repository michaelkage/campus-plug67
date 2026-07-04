/**
 * Campus Plug v6.8.0 — MultiMatch Selection Grid
 * Component 1 of Phase 1: Core SKU Intake
 *
 * Architecture:
 *   - 350ms debounce window on the search field
 *   - Fires match_global_sku(search_title) RPC (pg_trgm, similarity > 0.4)
 *   - Presents exactly 4 high-probability SKU variants with Framer Motion stagger
 *   - On selection: auto-fills parent form, locks fields into read-only badges,
 *     and enforces numeric price range bounding box limits
 *   - "None of the Above" path: unlocks manual entry and writes a curation alert
 *     to sku_curation_requests for admin review
 */

import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase, formatNaira } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import {
  Search, Check, X, Sparkles, Lock, AlertTriangle, ChevronRight,
} from 'lucide-react'
import toast from 'react-hot-toast'

// ── Debounce hook ─────────────────────────────────────────────────────────────
function useDebounce(value, delay) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

// ── RPC: fuzzy SKU match ──────────────────────────────────────────────────────
async function fetchSKUMatches(searchTitle) {
  if (!searchTitle || searchTitle.trim().length < 3) return []

  const { data, error } = await supabase.rpc('match_global_sku', {
    search_title: searchTitle.trim(),
  })

  if (error) {
    console.error('[MultiMatchSelectionGrid] SKU RPC error:', error.message)
    return []
  }

  // Always cap at exactly 4
  return (data || []).slice(0, 4)
}

// ── Curation alert ────────────────────────────────────────────────────────────
async function logCurationRequest(searchTitle, userId) {
  try {
    await supabase.from('sku_curation_requests').insert({
      search_title: searchTitle.trim(),
      requested_by: userId,
      status:       'pending',
    })
  } catch {
    // Non-fatal — best-effort admin signal
  }
}

// ── Similarity confidence pill ────────────────────────────────────────────────
function ConfidencePill({ similarity }) {
  const pct  = Math.round((similarity ?? 0) * 100)
  const color =
    pct >= 80 ? 'bg-plug-green/20 text-plug-green border-plug-green/30' :
    pct >= 55 ? 'bg-plug-amber/20 text-plug-amber border-plug-amber/30' :
                'bg-white/10 text-white/40 border-white/10'
  return (
    <span className={`inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full border ${color}`}>
      {pct}% match
    </span>
  )
}

// ── Locked field badge ────────────────────────────────────────────────────────
function LockedBadge({ label, value }) {
  return (
    <div className="flex items-center justify-between bg-obsidian-300 border border-obsidian-500
                    rounded-lg px-3 py-2 group">
      <span className="text-xs text-white/40">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-white font-mono">{value}</span>
        <Lock size={10} className="text-cyan/60 flex-shrink-0" />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * Props:
 *   onSKUSelect(sku | null)   — called when user picks a SKU or "None of the above"
 *   onFieldsLocked(fields)    — called with { title, category, priceMin, priceMax, lifespan }
 *                               when a SKU is confirmed so the parent form can populate/lock
 *   selectedSKU               — currently selected SKU object (controlled)
 *   initialSearch             — pre-fill the search input (e.g. from URL params)
 */
export default function MultiMatchSelectionGrid({
  onSKUSelect,
  onFieldsLocked,
  selectedSKU,
  initialSearch = '',
}) {
  const { user } = useAuth()
  const qc = useQueryClient()

  const [search,   setSearch]   = useState(initialSearch)
  const [typing,   setTyping]   = useState(false)
  const [showGrid, setShowGrid] = useState(true)

  const debounced = useDebounce(search, 350)  // 350ms per spec

  // Detect "user is still typing" for the Sparkles spinner
  useEffect(() => {
    setTyping(search !== debounced)
  }, [search, debounced])

  // ── SKU query ───────────────────────────────────────────────────────────────
  const {
    data:      matches = [],
    isFetching,
    isError,
  } = useQuery({
    queryKey:  ['sku-match', debounced],
    queryFn:   () => fetchSKUMatches(debounced),
    enabled:   debounced.trim().length >= 3,
    staleTime: 5 * 60_000,
  })

  const isLoading = isFetching || typing

  // ── Curation mutation ───────────────────────────────────────────────────────
  const curationMutation = useMutation({
    mutationFn: () => logCurationRequest(debounced, user?.id),
    onSuccess:  () => {
      toast.success('Custom listing started. Your search has been sent to our catalog team. 📋')
    },
  })

  // ── Selection handler ───────────────────────────────────────────────────────
  const handleSKUSelect = useCallback((sku) => {
    onSKUSelect(sku)
    setShowGrid(false)

    // Derive bounding box values and push to parent
    if (onFieldsLocked && sku) {
      onFieldsLocked({
        title:    sku.title,
        category: sku.category,
        priceMin: sku.lower_price_bound ?? 0,
        priceMax: sku.upper_price_bound ?? 0,
        lifespan: sku.baseline_lifespan ?? null,
      })
    }

    toast.success(`SKU locked: ${sku.title}`, { icon: '🔒' })
  }, [onSKUSelect, onFieldsLocked])

  // ── "None of the Above" handler ─────────────────────────────────────────────
  const handleNoneOfTheAbove = useCallback(() => {
    onSKUSelect(null)
    setShowGrid(false)
    curationMutation.mutate()
  }, [onSKUSelect, curationMutation])

  // ── Clear selection ─────────────────────────────────────────────────────────
  const handleClear = () => {
    onSKUSelect(null)
    if (onFieldsLocked) onFieldsLocked(null)
    setShowGrid(true)
    setSearch('')
  }

  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div className="w-full space-y-4">

      {/* ── Search input ─────────────────────────────────────────────────── */}
      <div className="relative">
        <Search
          size={16}
          className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none"
        />
        <input
          type="text"
          value={search}
          onChange={e => { setSearch(e.target.value); setShowGrid(true) }}
          placeholder="What are you listing? (e.g. 'iPhone 13', '3-in-1 mattress')"
          className="input pl-10 pr-10 w-full"
          autoComplete="off"
          spellCheck={false}
        />
        {/* Typing / loading indicator */}
        <AnimatePresence>
          {(typing || isLoading) && debounced.length >= 3 && (
            <motion.span
              key="spinner"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="absolute right-3.5 top-1/2 -translate-y-1/2"
            >
              <Sparkles size={14} className="text-cyan animate-pulse" />
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* ── Locked SKU summary (post-selection) ──────────────────────────── */}
      <AnimatePresence mode="wait">
        {selectedSKU && !showGrid && (
          <motion.div
            key="locked"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            className="bg-plug-green/5 border border-plug-green/25 rounded-xl p-4 space-y-3"
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Check size={15} className="text-plug-green" />
                <span className="text-sm font-bold text-plug-green">SKU LOCKED</span>
              </div>
              <button
                onClick={handleClear}
                className="text-xs text-white/30 hover:text-white flex items-center gap-1 transition-colors"
              >
                <X size={11} /> Change
              </button>
            </div>

            {/* Locked field badges */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <LockedBadge label="Product" value={selectedSKU.title} />
              <LockedBadge label="Category" value={selectedSKU.category ?? '—'} />
              <LockedBadge
                label="Price Floor"
                value={formatNaira(selectedSKU.lower_price_bound)}
              />
              <LockedBadge
                label="Price Ceiling"
                value={formatNaira(selectedSKU.upper_price_bound)}
              />
              {selectedSKU.baseline_lifespan && (
                <LockedBadge label="Est. Lifespan" value={selectedSKU.baseline_lifespan} />
              )}
            </div>

            <p className="text-[10px] text-white/30 leading-relaxed">
              Price range and product metadata are enforced by the SKU catalog.
              Listings outside the ₦{(selectedSKU.lower_price_bound / 100).toLocaleString()} –{' '}
              ₦{(selectedSKU.upper_price_bound / 100).toLocaleString()} range will be flagged.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── SKU match grid ────────────────────────────────────────────────── */}
      <AnimatePresence mode="wait">
        {showGrid && debounced.length >= 3 && (
          <motion.div
            key="grid"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {/* Error state */}
            {isError && (
              <div className="flex items-center gap-2 text-xs text-plug-red bg-plug-red/5
                              border border-plug-red/20 rounded-lg px-3 py-2 mb-3">
                <AlertTriangle size={12} />
                SKU catalog unavailable. Proceed with manual entry.
              </div>
            )}

            {/* Loading skeleton */}
            {isLoading && (
              <div className="grid grid-cols-2 gap-3">
                {[0, 1, 2, 3].map(i => (
                  <div
                    key={i}
                    className="h-28 bg-obsidian-400 border border-obsidian-500 rounded-xl animate-pulse"
                  />
                ))}
              </div>
            )}

            {/* Match cards — exactly 4 */}
            {!isLoading && matches.length > 0 && (
              <>
                <p className="text-[10px] text-white/30 uppercase tracking-widest mb-3 font-bold">
                  {matches.length} catalog match{matches.length !== 1 ? 'es' : ''} — select one
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {matches.map((sku, idx) => {
                    const isSelected = selectedSKU?.id === sku.id
                    return (
                      <motion.button
                        key={sku.id}
                        type="button"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.06, type: 'spring', stiffness: 380, damping: 26 }}
                        onClick={() => handleSKUSelect(sku)}
                        className={`relative text-left p-4 rounded-xl border-2 transition-all duration-150
                                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan
                                    ${isSelected
                                      ? 'border-plug-green bg-plug-green/8 shadow-lg shadow-plug-green/10'
                                      : 'border-obsidian-500 bg-obsidian-400 hover:border-cyan/40 hover:bg-obsidian-300'
                                    }`}
                      >
                        {/* Selection check */}
                        {isSelected && (
                          <span className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full
                                           bg-plug-green flex items-center justify-center">
                            <Check size={11} className="text-obsidian" />
                          </span>
                        )}

                        {/* SKU title */}
                        <div className="flex items-start gap-2 mb-2 pr-6">
                          <h3 className="font-bold text-sm text-white leading-tight line-clamp-2">
                            {sku.title}
                          </h3>
                        </div>

                        {/* Meta row */}
                        <div className="flex items-center justify-between mb-2">
                          {sku.category && (
                            <span className="tag tag-cyan text-[10px]">{sku.category}</span>
                          )}
                          <ConfidencePill similarity={sku.similarity} />
                        </div>

                        {/* Price bounds */}
                        <div className="space-y-1 text-xs">
                          <div className="flex justify-between text-white/40">
                            <span>Range</span>
                            <span className="text-white font-mono font-semibold">
                              {formatNaira(sku.lower_price_bound)}
                              {' – '}
                              {formatNaira(sku.upper_price_bound)}
                            </span>
                          </div>
                          {sku.baseline_lifespan && (
                            <div className="flex justify-between text-white/40">
                              <span>Lifespan</span>
                              <span className="text-white/70">{sku.baseline_lifespan}</span>
                            </div>
                          )}
                        </div>

                        {/* Verified metadata indicator */}
                        {sku.verified_metadata &&
                          Object.keys(sku.verified_metadata).length > 0 && (
                            <div className="mt-2 pt-2 border-t border-obsidian-500 flex items-center gap-1">
                              <Sparkles size={9} className="text-cyan" />
                              <span className="text-[9px] text-cyan font-bold uppercase tracking-wider">
                                Verified catalog entry
                              </span>
                            </div>
                          )}
                      </motion.button>
                    )
                  })}
                </div>

                {/* None of the Above */}
                <motion.button
                  type="button"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.28 }}
                  onClick={handleNoneOfTheAbove}
                  disabled={curationMutation.isPending}
                  className="mt-3 w-full flex items-center justify-between px-4 py-3 rounded-xl
                             border-2 border-dashed border-white/10 text-white/40
                             hover:border-plug-amber/40 hover:text-plug-amber
                             disabled:opacity-40 disabled:cursor-not-allowed
                             transition-all duration-150 group"
                >
                  <div className="flex items-center gap-2">
                    <X size={14} />
                    <span className="text-sm font-semibold">None of the above</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px]">Manual listing</span>
                    <ChevronRight size={12} className="group-hover:translate-x-0.5 transition-transform" />
                  </div>
                </motion.button>
              </>
            )}

            {/* No matches + None of Above */}
            {!isLoading && !isError && matches.length === 0 && debounced.length >= 3 && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-3"
              >
                <div className="text-center py-6 text-white/30">
                  <Search size={24} className="mx-auto mb-2 opacity-30" />
                  <p className="text-sm font-semibold">No SKU catalog matches</p>
                  <p className="text-xs mt-1">
                    "{debounced}" isn't in our catalog yet.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleNoneOfTheAbove}
                  disabled={curationMutation.isPending}
                  className="w-full flex items-center justify-between px-4 py-3 rounded-xl
                             bg-obsidian-400 border border-obsidian-500 text-white
                             hover:border-cyan/40 disabled:opacity-40 disabled:cursor-not-allowed
                             transition-all duration-150 group"
                >
                  <div className="flex items-center gap-2">
                    <X size={14} className="text-white/40" />
                    <div className="text-left">
                      <p className="text-sm font-semibold">Continue with manual listing</p>
                      <p className="text-[10px] text-white/30">
                        We'll add this to the catalog review queue
                      </p>
                    </div>
                  </div>
                  <ChevronRight
                    size={14}
                    className="text-white/30 group-hover:text-white group-hover:translate-x-0.5
                               transition-all"
                  />
                </button>
              </motion.div>
            )}

            {/* Hint: minimum chars */}
            {!isLoading && debounced.length > 0 && debounced.length < 3 && (
              <p className="text-xs text-white/25 text-center py-2">
                Type at least 3 characters to search the catalog
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
