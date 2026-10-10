import { useCallback, useEffect, useState } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { supabase, formatNaira, openPaystack, generatePaystackRef, callEdgeFunction } from '@/lib/supabase'
import { WalletCards, ArrowDownToLine, ShieldCheck, Zap, RefreshCw, HelpCircle } from 'lucide-react'
import toast from 'react-hot-toast'

const PENDING_REFERENCE_KEY = 'cp_wallet_pending_reference'

export default function CampusWallet() {
  const { user } = useAuth()
  const [balance, setBalance] = useState(0)
  const [amount, setAmount] = useState('5000')
  const [loading, setLoading] = useState(true)
  const [funding, setFunding] = useState(false)
  const userId = user?.id
  const [recoveryReference, setRecoveryReference] = useState(() => {
    try { return sessionStorage.getItem(PENDING_REFERENCE_KEY) ?? '' } catch { return '' }
  })

  const refresh = useCallback(async () => {
    if (!userId) { setLoading(false); return }
    setLoading(true)
    try {
      const { data, error } = await supabase.from('profiles').select('plug_credit_balance').eq('id', userId).single()
      if (error) throw error
      setBalance(Number(data?.plug_credit_balance ?? 0))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load wallet balance')
    } finally {
      setLoading(false)
    }
  }, [userId])

  useEffect(() => { void refresh() }, [refresh])

  const getAmountKobo = () => {
    const naira = Number(amount)
    const kobo = Math.round(naira * 100)
    if (!Number.isSafeInteger(kobo) || kobo < 1000) {
      toast.error('Enter a valid amount of at least ₦10')
      return null
    }
    return kobo
  }

  const verifyAndCredit = async (reference: string, amountKobo: number) => {
    const result = await callEdgeFunction<{ success?: boolean; already_credited?: boolean; amount_kobo?: number }>(
      'fund-wallet',
      { reference, amount_kobo: amountKobo },
    )
    if (result.error) throw new Error(result.error)
    const data = result.data
    if (!data || (!data.success && !data.already_credited)) throw new Error('Payment could not be confirmed. If you were charged, keep the reference and try verification again.')
    try { sessionStorage.removeItem(PENDING_REFERENCE_KEY) } catch { /* Storage may be disabled. */ }
    setRecoveryReference('')
    toast.success(data.already_credited ? 'This top-up was already credited' : `Campus Wallet funded with ${formatNaira(amountKobo)}`)
    await refresh()
  }

  const fund = async () => {
    if (!user) { toast.error('Sign in to fund your wallet'); return }
    const kobo = getAmountKobo()
    if (kobo === null) return
    const publicKey = import.meta.env.VITE_PAYSTACK_PUBLIC_KEY
    if (!publicKey) { toast.error('Wallet payments are not configured. Please contact support.'); return }

    setFunding(true)
    const reference = generatePaystackRef('WALLET')
    setRecoveryReference(reference)
    try { sessionStorage.setItem(PENDING_REFERENCE_KEY, reference) } catch { /* Recovery field remains visible. */ }
    try {
      await openPaystack({ email: user.email || '', amount: kobo, ref: reference, publicKey, metadata: { type: 'campus_wallet_funding', user_id: user.id } })
      await verifyAndCredit(reference, kobo)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Wallet funding failed')
    } finally {
      setFunding(false)
    }
  }

  const recover = async () => {
    if (!user) { toast.error('Sign in to verify your wallet payment'); return }
    const reference = recoveryReference.trim()
    const kobo = getAmountKobo()
    if (!reference) { toast.error('Enter the Paystack reference from your previous payment'); return }
    if (kobo === null) return
    setFunding(true)
    try {
      await verifyAndCredit(reference, kobo)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not verify this payment')
    } finally {
      setFunding(false)
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">
      <section className="bg-surface-container-high border border-primary/20 rounded-3xl p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-primary text-xs font-bold uppercase tracking-widest"><WalletCards size={15} />Campus Wallet</div>
            <h1 className="text-2xl font-black mt-2">One Paystack top-up. Many tiny swaps.</h1>
            <p className="text-sm text-white/45 mt-2 max-w-xl">Use stored Campus Wallet value for low-cost academic purchases and rentals. Internal wallet transfers do not run another Paystack checkout.</p>
          </div>
          <button type="button" onClick={() => void refresh()} aria-label="Refresh wallet balance" className="p-2 rounded-lg border border-outline-variant text-white/40 hover:text-white"><RefreshCw size={15} /></button>
        </div>
        <div className="mt-6 rounded-3xl border border-primary/20 bg-primary/5 p-5">
          <div className="text-[10px] uppercase tracking-widest text-white/35">Available balance</div>
          <div className="text-4xl font-black font-mono text-primary mt-1">{loading ? '…' : formatNaira(balance)}</div>
        </div>
      </section>

      <div className="grid md:grid-cols-2 gap-5">
        <section className="bg-surface-container-high border border-outline-variant rounded-3xl p-5">
          <div className="flex items-center gap-2 mb-3"><ArrowDownToLine size={15} className="text-primary" /><h2 className="font-bold text-sm">Fund wallet</h2></div>
          <p className="text-xs text-white/40 mb-4">Paystack is used only when you add money. The server verifies the reference before crediting your wallet.</p>
          <label htmlFor="wallet-amount" className="block text-xs text-white/55 mb-2">Amount (NGN)</label>
          <div className="flex gap-2">
            <input id="wallet-amount" className="input flex-1 min-w-0" type="number" min="10" step="10" value={amount} onChange={e => setAmount(e.target.value)} disabled={funding} />
            <button type="button" onClick={() => void fund()} disabled={funding} className="btn-primary px-4 disabled:opacity-40">{funding ? 'Processing…' : 'Add funds'}</button>
          </div>
        </section>
        <section className="bg-surface-container-high border border-outline-variant rounded-3xl p-5">
          <div className="flex items-center gap-2 mb-3"><Zap size={15} className="text-tertiary" /><h2 className="font-bold text-sm">Micro-escrow lane</h2></div>
          <p className="text-xs text-white/40">Purchases up to <strong className="text-white">₦10,000</strong> can use Campus Wallet escrow. Higher-value deals stay on the protected Paystack escrow path.</p>
          <div className="mt-4 text-[10px] text-white/30">No second card checkout for internal wallet settlement.</div>
        </section>
      </div>

      <section className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-4">
        <div className="flex items-start gap-3">
          <HelpCircle size={16} className="text-amber-300 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-bold">Recover a previous top-up</h2>
            <p className="text-xs text-white/50 mt-1 mb-3">If Paystack completed but your balance did not update, enter the original reference and the exact amount you paid. This verifies the existing payment; it does not start another checkout.</p>
            <label htmlFor="wallet-reference" className="block text-xs text-white/55 mb-2">Paystack reference</label>
            <input id="wallet-reference" className="input w-full mb-3" value={recoveryReference} onChange={e => setRecoveryReference(e.target.value)} placeholder="WALLET-…" autoComplete="off" disabled={funding} />
            <button type="button" onClick={() => void recover()} disabled={funding || !recoveryReference.trim()} className="btn-secondary px-4 disabled:opacity-40">{funding ? 'Verifying…' : 'Verify previous payment'}</button>
          </div>
        </div>
      </section>

      <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 flex gap-3">
        <ShieldCheck size={16} className="text-primary flex-shrink-0" />
        <div className="text-xs text-white/45"><strong className="text-white">Server-authoritative:</strong> wallet debits, escrow holds, releases, refunds, and Paystack verification happen server-side. A browser callback alone cannot create wallet value.</div>
      </div>
    </div>
  )
}
