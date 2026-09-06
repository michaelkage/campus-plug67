import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { supabase, formatNaira } from '@/lib/supabase'
import { WalletCards } from 'lucide-react'
import toast from 'react-hot-toast'

const LIMIT_KOBO = 1_000_000

export default function MicroEscrowLauncher() {
  const { user } = useAuth()
  const location = useLocation()
  const navigate = useNavigate()
  const [listing, setListing] = useState<any>(null)
  const [balance, setBalance] = useState(0)
  const [busy, setBusy] = useState(false)

  const match = location.pathname.match(/^\/marketplace\/([^/]+)$/)
  const listingId = match?.[1]

  useEffect(() => {
    if (!listingId || !user) { setListing(null); return }
    let active = true
    void (async () => {
      const [{ data: item }, { data: profile }] = await Promise.all([
        supabase.from('listings').select('id,title,price,seller_id,status').eq('id', listingId).maybeSingle(),
        supabase.from('profiles').select('plug_credit_balance').eq('id', user.id).maybeSingle(),
      ])
      if (active) { setListing(item); setBalance(Number(profile?.plug_credit_balance || 0)) }
    })()
    return () => { active = false }
  }, [listingId, user?.id])

  if (!listing || listing.seller_id === user?.id || listing.status !== 'active' || Number(listing.price) > LIMIT_KOBO) return null

  const buy = async () => {
    if (!user) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('create_wallet_micro_escrow', { p_listing_id: listing.id })
      if (error) throw error
      if (!data?.success) throw new Error('Campus Wallet purchase failed')
      toast.success('🔐 Wallet escrow locked — no Paystack checkout needed.')
      navigate(`/marketplace/${listing.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Campus Wallet purchase failed')
    } finally { setBusy(false) }
  }

  return <div className="fixed bottom-20 sm:bottom-6 right-4 z-40 w-[min(360px,calc(100vw-2rem))] bg-obsidian-400 border border-plug-green/30 rounded-2xl p-4 shadow-2xl">
    <div className="flex items-start gap-3"><div className="w-9 h-9 rounded-xl bg-plug-green/10 border border-plug-green/20 flex items-center justify-center flex-shrink-0"><WalletCards size={16} className="text-plug-green" /></div><div className="flex-1 min-w-0"><div className="text-xs font-black text-plug-green uppercase tracking-wider">Campus Wallet micro-escrow</div><div className="text-[11px] text-white/45 mt-1">{formatNaira(Number(listing.price))} · balance {formatNaira(balance)}</div></div></div>
    <button onClick={() => void buy()} disabled={busy || balance < Number(listing.price)} className="w-full mt-3 py-2.5 rounded-xl bg-plug-green text-obsidian font-black text-xs disabled:opacity-30 disabled:cursor-not-allowed">{busy ? 'LOCKING WALLET FUNDS…' : balance < Number(listing.price) ? 'TOP UP WALLET FIRST' : 'BUY WITH CAMPUS WALLET'}</button>
    <p className="text-[9px] text-white/25 mt-2 text-center">For items ≤ ₦10,000. Higher-value items use Paystack escrow.</p>
  </div>
}
