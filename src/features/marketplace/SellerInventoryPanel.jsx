import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase, formatNaira } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { Archive, RotateCcw, Package, Eye, Clock3, ShieldAlert } from 'lucide-react'

const PAGE_SIZE = 20
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'reserved', label: 'Reserved' },
  { id: 'sold', label: 'Sold' },
  { id: 'deleted', label: 'Archived' },
]
const EMPTY_COUNTS = { all: 0, active: 0, reserved: 0, sold: 0, deleted: 0, pending: 0 }

async function fetchSellerInventory(sellerId, filter, page) {
  const from = page * PAGE_SIZE
  let query = supabase.from('listings')
    .select('id,title,price,status,images,created_at,updated_at,view_count,category', { count: 'exact' })
    .eq('seller_id', sellerId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + PAGE_SIZE - 1)

  if (filter !== 'all') query = query.eq('status', filter)
  const { data, error, count } = await query
  if (error) throw error

  const statusQueries = ['active', 'reserved', 'sold', 'deleted', 'pending'].map(async status => {
    const result = await supabase.from('listings')
      .select('id', { count: 'exact', head: true })
      .eq('seller_id', sellerId)
      .eq('status', status)
    if (result.error) throw result.error
    return [status, result.count ?? 0]
  })
  const statusCounts = Object.fromEntries(await Promise.all(statusQueries))
  const allCount = await supabase.from('listings')
    .select('id', { count: 'exact', head: true })
    .eq('seller_id', sellerId)
  if (allCount.error) throw allCount.error

  return {
    rows: data ?? [],
    total: count ?? 0,
    counts: { ...EMPTY_COUNTS, ...statusCounts, all: allCount.count ?? 0 },
  }
}

export default function SellerInventoryPanel({ sellerId }) {
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(0)
  const queryClient = useQueryClient()
  const queryKey = ['seller-inventory', sellerId, filter, page]
  const inventory = useQuery({
    queryKey,
    queryFn: () => fetchSellerInventory(sellerId, filter, page),
    enabled: Boolean(sellerId),
    staleTime: 20_000,
  })

  const statusMutation = useMutation({
    mutationFn: async ({ listingId, fromStatus, toStatus }) => {
      const { data, error } = await supabase.from('listings')
        .update({ status: toStatus })
        .eq('id', listingId)
        .eq('seller_id', sellerId)
        .eq('status', fromStatus)
        .select('id')
        .maybeSingle()
      if (error) throw error
      if (!data) throw new Error('This listing changed or is no longer eligible. Refresh and try again.')
      return data
    },
    onSuccess: async (_, variables) => {
      toast.success(variables.toStatus === 'deleted' ? 'Listing archived' : 'Listing restored')
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['seller-inventory', sellerId] }),
        queryClient.invalidateQueries({ queryKey: ['user-listings', sellerId] }),
        queryClient.invalidateQueries({ queryKey: ['listings'] }),
      ])
    },
    onError: error => {
      const message = error?.message || 'Unable to update this listing'
      toast.error(message.includes('active transaction') || message.includes('reserved')
        ? 'This listing is attached to an active transaction and cannot be changed.'
        : message)
    },
  })

  const counts = inventory.data?.counts ?? EMPTY_COUNTS
  const totalPages = Math.max(1, Math.ceil((inventory.data?.total ?? 0) / PAGE_SIZE))
  const rows = inventory.data?.rows ?? []
  const summary = useMemo(() => [
    { label: 'Active', value: counts.active, tone: 'text-primary' },
    { label: 'Reserved', value: counts.reserved, tone: 'text-[var(--md-secondary)]' },
    { label: 'Sold', value: counts.sold, tone: 'text-[var(--md-tertiary)]' },
    { label: 'Archived', value: counts.deleted, tone: 'text-on-surface/50' },
  ], [counts.active, counts.reserved, counts.sold, counts.deleted])

  return (
    <section className="space-y-4" aria-labelledby="seller-inventory-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="seller-inventory-heading" className="font-bold text-lg">Inventory & listing health</h2>
          <p className="text-xs text-on-surface/45 mt-1">Track availability, demand and listing status. Reserved items are locked by escrow.</p>
        </div>
        <Link to="/marketplace" className="btn-primary text-xs py-2">Create listing</Link>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {summary.map(item => (
          <div key={item.label} className="rounded-md border border-outline-variant bg-surface-container-high p-3">
            <div className={`text-xl font-black tabular-nums ${item.tone}`}>{item.value}</div>
            <div className="text-[10px] uppercase tracking-wide text-on-surface/45">{item.label}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Filter listings by status">
        {FILTERS.map(item => (
          <button key={item.id} type="button" role="tab" aria-selected={filter === item.id}
            onClick={() => { setFilter(item.id); setPage(0) }}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${filter === item.id ? 'border-primary bg-[var(--md-primary)]/10 text-primary' : 'border-outline-variant text-on-surface/55'}`}>
            {item.label} <span className="ml-1 tabular-nums">{counts[item.id]}</span>
          </button>
        ))}
      </div>

      {inventory.isPending ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-label="Loading inventory">
          {[0, 1, 2, 3].map(item => <div key={item} className="h-28 animate-pulse rounded-md bg-surface-container-high" />)}
        </div>
      ) : inventory.isError ? (
        <div className="rounded-md border border-error/30 bg-error/5 p-5 text-sm" role="alert">
          Unable to load your inventory. {inventory.error?.message || 'Try refreshing the page.'}
          <button className="ml-2 underline" onClick={() => inventory.refetch()}>Retry</button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-md border border-outline-variant bg-surface-container-high p-10 text-center">
          <Package size={30} className="mx-auto mb-3 text-on-surface/30" />
          <p className="text-sm font-semibold">{filter === 'all' ? 'No listings yet' : `No ${filter} listings`}</p>
          <p className="mt-1 text-xs text-on-surface/45">{filter === 'all' ? 'Publish an item to start managing your inventory.' : 'Listings in this status will appear here.'}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(listing => {
            const isBusy = statusMutation.isPending && statusMutation.variables?.listingId === listing.id
            const canArchive = listing.status === 'active'
            const canRestore = listing.status === 'deleted'
            return (
              <article key={listing.id} className="flex min-w-0 gap-3 rounded-md border border-outline-variant bg-surface-container-high p-3">
                <Link to={`/marketplace/${listing.id}`} className="h-20 w-20 shrink-0 overflow-hidden rounded bg-surface-container-highest" aria-label={`View ${listing.title}`}>
                  {listing.images?.[0]
                    ? <img src={listing.images[0]} alt="" loading="lazy" className="h-full w-full object-cover" />
                    : <div className="flex h-full items-center justify-center text-2xl">📦</div>}
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to={`/marketplace/${listing.id}`} className="truncate text-sm font-semibold hover:text-primary">{listing.title}</Link>
                    <span className={`rounded-full px-2 py-0.5 text-[9px] uppercase tracking-wide ${listing.status === 'active' ? 'bg-primary/10 text-primary' : listing.status === 'reserved' ? 'bg-[var(--md-secondary)]/10 text-[var(--md-secondary)]' : listing.status === 'sold' ? 'bg-[var(--md-tertiary)]/10 text-[var(--md-tertiary)]' : 'bg-surface-container-highest text-on-surface/50'}`}>{listing.status === 'deleted' ? 'archived' : listing.status}</span>
                  </div>
                  <div className="mt-1 font-mono text-sm font-bold">{formatNaira(listing.price)}</div>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-on-surface/45">
                    <span className="inline-flex items-center gap-1"><Eye size={11} />{listing.view_count ?? 0} views</span>
                    <span className="inline-flex items-center gap-1"><Clock3 size={11} />{new Date(listing.created_at).toLocaleDateString()}</span>
                    {listing.status === 'reserved' && <span className="inline-flex items-center gap-1"><ShieldAlert size={11} />Escrow in progress</span>}
                  </div>
                </div>
                <div className="flex shrink-0 flex-col justify-center gap-1">
                  {canArchive && <button type="button" disabled={isBusy} onClick={() => statusMutation.mutate({ listingId: listing.id, fromStatus: 'active', toStatus: 'deleted' })} className="btn-ghost inline-flex items-center gap-1 text-[10px] disabled:opacity-40"><Archive size={12} />Archive</button>}
                  {canRestore && <button type="button" disabled={isBusy} onClick={() => statusMutation.mutate({ listingId: listing.id, fromStatus: 'deleted', toStatus: 'active' })} className="btn-ghost inline-flex items-center gap-1 text-[10px] disabled:opacity-40"><RotateCcw size={12} />Restore</button>}
                </div>
              </article>
            )
          })}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-3" aria-label="Inventory pages">
          <button type="button" className="btn-secondary text-xs" disabled={page === 0} onClick={() => setPage(value => Math.max(0, value - 1))}>Previous</button>
          <span className="text-xs text-on-surface/50" aria-live="polite">Page {page + 1} of {totalPages}</span>
          <button type="button" className="btn-secondary text-xs" disabled={page + 1 >= totalPages} onClick={() => setPage(value => value + 1)}>Next</button>
        </nav>
      )}
      <p className="text-[10px] text-on-surface/40">Inventory is single-item per listing today. A reserved or sold listing cannot be archived or restored by the seller.</p>
    </section>
  )
}
