/**
 * Campus Plug — MultiMatch Selection Grid
 *
 * Debounced intake feed matching exactly 4 global SKU options from the catalog.
 * Uses fuzzy string matching via pg_trgm extension with > 0.4 similarity threshold.
 *
 * Architecture:
 * - Debounced input (300ms) to prevent excessive RPC calls
 * - Calls match_global_sku(search_title) RPC function
 * - Displays exactly 4 best-matching SKUs + "None of the Above" option
 * - Applies dynamic lifespan and price bounds from matched SKU
 */

import { useState, useCallback, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { motion, AnimatePresence } from 'framer-motion'
import { supabase } from '@/lib/supabase'
import { Search, Check, X, Sparkles } from 'lucide-react'
import toast from 'react-hot-toast'

// ── Debounce Hook ─────────────────────────────────────────────────────────────

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])

  return debouncedValue
}

// ── RPC Call for SKU Matching ───────────────────────────────────────────────────

async function matchGlobalSKU(searchTitle) {
  if (!searchTitle || searchTitle.length < 3) return []

  const { data, error } = await supabase.rpc('match_global_sku', {
    search_title: searchTitle,
  })

  if (error) {
    console.error('SKU matching error:', error)
    return []
  }

  // Return exactly 4 best matches or empty array
  return data?.slice(0, 4) || []
}

// ── Component ───────────────────────────────────────────────────────────────────

export default function MultiMatchSelectionGrid({ onSKUSelect, selectedSKU, initialSearch = '' }) {
  const [searchInput, setSearchInput] = useState(initialSearch)
  const [isTyping, setIsTyping] = useState(false)
  
  const debouncedSearch = useDebounce(searchInput, 300)
  
  // Query for SKU matches
  const { data: skuMatches = [], isLoading, error } = useQuery({
    queryKey: ['sku-match', debouncedSearch],
    queryFn: () => matchGlobalSKU(debouncedSearch),
    enabled: debouncedSearch.length >= 3,
    staleTime: 5 * 60 * 1000, // 5 minutes cache
  })

  // Handle typing state for UI feedback
  useEffect(() => {
    setIsTyping(searchInput !== debouncedSearch)
  }, [searchInput, debouncedSearch])

  const handleInputChange = (e) => {
    setSearchInput(e.target.value)
  }

  const handleSKUSelect = (sku) => {
    onSKUSelect(sku)
    toast.success(`Selected: ${sku.title}`)
  }

  const handleNoneOfTheAbove = () => {
    onSKUSelect(null)
    toast.success('Using custom listing (no SKU match)')
  }

  return (
    <div className="w-full max-w-2xl mx-auto p-4">
      {/* Search Input */}
      <div className="relative mb-6">
        <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
        <input
          type="text"
          value={searchInput}
          onChange={handleInputChange}
          placeholder="What are you listing? (e.g., 'iPhone 13', '3-in-1 mattress')"
          className="w-full pl-12 pr-4 py-4 bg-gray-900 border border-gray-700 rounded-xl text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-campus-green focus:border-transparent transition-all"
        />
        {isTyping && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="absolute right-4 top-1/2 transform -translate-y-1/2"
          >
            <Sparkles className="w-5 h-5 text-campus-green animate-pulse" />
          </motion.div>
        )}
      </div>

      {/* Loading State */}
      {isLoading && debouncedSearch.length >= 3 && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-8 text-gray-400"
        >
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-campus-green"></div>
          <p className="mt-2 text-sm">Matching against SKU catalog...</p>
        </motion.div>
      )}

      {/* Error State */}
      {error && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="bg-red-900/20 border border-red-700 rounded-lg p-4 mb-4"
        >
          <p className="text-red-400 text-sm">Failed to match SKUs. Please try again.</p>
        </motion.div>
      )}

      {/* SKU Matches Grid */}
      <AnimatePresence mode="wait">
        {skuMatches.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="grid grid-cols-1 md:grid-cols-2 gap-4"
          >
            {skuMatches.map((sku, index) => {
              const isSelected = selectedSKU?.id === sku.id
              return (
                <motion.button
                  key={sku.id}
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: index * 0.05 }}
                  onClick={() => handleSKUSelect(sku)}
                  className={`relative p-4 rounded-xl border-2 transition-all ${
                    isSelected
                      ? 'border-campus-green bg-campus-green/10'
                      : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                  }`}
                >
                  <div className="flex items-start justify-between mb-2">
                    <h3 className="font-semibold text-white text-left">{sku.title}</h3>
                    {isSelected && (
                      <Check className="w-5 h-5 text-campus-green flex-shrink-0" />
                    )}
                  </div>
                  
                  <div className="space-y-1 text-left text-sm">
                    <div className="flex justify-between text-gray-400">
                      <span>Lifespan:</span>
                      <span className="text-white">{sku.baseline_lifespan || 'Auto'}</span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span>Price Range:</span>
                      <span className="text-white">
                        ₦{(sku.lower_price_bound / 100).toLocaleString()} - ₦{(sku.upper_price_bound / 100).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {sku.verified_metadata && Object.keys(sku.verified_metadata).length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-700">
                      <span className="text-xs text-campus-green flex items-center gap-1">
                        <Sparkles className="w-3 h-3" />
                        Verified Metadata
                      </span>
                    </div>
                  )}
                </motion.button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>

      {/* None of the Above Option */}
      {debouncedSearch.length >= 3 && skuMatches.length === 0 && !isLoading && (
        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          onClick={handleNoneOfTheAbove}
          className="w-full p-4 rounded-xl border-2 border-dashed border-gray-600 bg-gray-800/50 hover:border-gray-500 transition-all group"
        >
          <div className="flex items-center justify-center gap-2 text-gray-400 group-hover:text-white">
            <X className="w-5 h-5" />
            <span className="font-medium">None of the Above</span>
          </div>
          <p className="text-xs text-gray-500 mt-1">Create a custom listing without SKU match</p>
        </motion.button>
      )}

      {/* Selected SKU Summary */}
      {selectedSKU && (
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-6 p-4 bg-campus-green/10 border border-campus-green rounded-xl"
        >
          <div className="flex items-center gap-3">
            <Check className="w-6 h-6 text-campus-green" />
            <div>
              <h4 className="font-semibold text-white">{selectedSKU.title}</h4>
              <p className="text-sm text-gray-400">
                Dynamic lifespan and price bounds will be applied automatically
              </p>
            </div>
          </div>
        </motion.div>
      )}
    </div>
  )
}
