import { useEffect, useMemo, useState } from 'react'
import { Building2, CheckCircle2, ShieldCheck, Wallet } from 'lucide-react'
import { supabase } from '@/lib/supabase'

type Bank = { name: string; code: string }
type SavedRecipient = {
  bank_name: string
  account_name: string
  account_last4: string
  currency: string
  verified_at: string
}
type ResolvedAccount = { account_name: string; account_last4: string; bank_code: string }

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke('manage-payout-recipient', { body })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context) {
      const payload = await context.clone().json().catch(() => null)
      if (typeof payload?.error === 'string') throw new Error(payload.error)
    }
    throw new Error(error.message || 'Payout account request failed')
  }
  if (!data) throw new Error('Payout account service returned no response')
  if (typeof data.error === 'string') throw new Error(data.error)
  return data as T
}

export default function SellerPayoutSettings() {
  const [banks, setBanks] = useState<Bank[]>([])
  const [saved, setSaved] = useState<SavedRecipient | null>(null)
  const [bankCode, setBankCode] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [resolved, setResolved] = useState<ResolvedAccount | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selectedBank = useMemo(() => banks.find((bank) => bank.code === bankCode) ?? null, [banks, bankCode])

  useEffect(() => {
    let active = true
    void Promise.all([
      invoke<{ banks: Bank[] }>({ action: 'list_banks' }),
      invoke<{ recipient: SavedRecipient | null }>({ action: 'current' }),
    ]).then(([bankResult, recipientResult]) => {
      if (!active) return
      setBanks(bankResult.banks)
      setSaved(recipientResult.recipient)
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Unable to load payout settings')
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])

  const resetVerification = () => {
    setResolved(null)
    setConfirmed(false)
    setError('')
  }

  const verifyAccount = async () => {
    if (!selectedBank || !/^\d{10}$/.test(accountNumber)) return
    setVerifying(true)
    setError('')
    setResolved(null)
    setConfirmed(false)
    try {
      const result = await invoke<ResolvedAccount>({
        action: 'resolve',
        bank_code: bankCode,
        account_number: accountNumber,
      })
      setResolved(result)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not verify this bank account')
    } finally {
      setVerifying(false)
    }
  }

  const saveAccount = async () => {
    if (!resolved || !selectedBank || !confirmed || !/^\d{10}$/.test(accountNumber)) return
    setSaving(true)
    setError('')
    try {
      const result = await invoke<{ recipient: { bank_name: string; account_name: string; account_last4: string; currency: string; verified_at: string } }>({
        action: 'save',
        bank_code: bankCode,
        account_number: accountNumber,
        confirmed_account_name: resolved.account_name,
        confirm_ownership: true,
      })
      setSaved({
        bank_name: result.recipient.bank_name,
        account_name: result.recipient.account_name,
        account_last4: result.recipient.account_last4,
        currency: result.recipient.currency,
        verified_at: result.recipient.verified_at,
      })
      setAccountNumber('')
      setResolved(null)
      setConfirmed(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save payout account')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <section className="surface p-5"><p className="text-sm text-on-surface/55">Loading seller payout settings…</p></section>
  }

  return (
    <section className="surface space-y-5 p-5">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary"><Building2 size={19} /></div>
        <div className="min-w-0 flex-1">
          <h2 className="font-black">Seller bank payout</h2>
          <p className="mt-1 text-xs leading-relaxed text-on-surface/50">
            Paystack-funded sales are paid to this verified bank account after escrow is resolved. Campus Wallet proceeds still go to PlugCredit.
          </p>
        </div>
      </div>

      {saved && (
        <div className="rounded-lg border border-[var(--md-outline-variant)] p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <CheckCircle2 size={16} className="text-primary" />
            Saved payout account
          </div>
          <p className="mt-2 text-sm font-bold">{saved.account_name}</p>
          <p className="text-sm text-on-surface/65">{saved.bank_name} · •••• {saved.account_last4}</p>
          <p className="mt-2 text-[11px] text-on-surface/40">
            Verified {new Date(saved.verified_at).toLocaleDateString()} · {saved.currency}
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-on-surface/50">
            Replacing this account applies to future transfer attempts. Transfers already submitted remain bound to the previous account until Paystack resolves them.
          </p>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-on-surface/65">Bank</span>
          <select
            className="input w-full"
            value={bankCode}
            onChange={(event) => { setBankCode(event.target.value); resetVerification() }}
            disabled={verifying || saving}
          >
            <option value="">Select your bank</option>
            {banks.map((bank) => <option key={bank.code} value={bank.code}>{bank.name}</option>)}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-on-surface/65">10-digit account number</span>
          <input
            className="input w-full"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            maxLength={10}
            value={accountNumber}
            onChange={(event) => { setAccountNumber(event.target.value.replace(/\D/g, '').slice(0, 10)); resetVerification() }}
            placeholder="0123456789"
            disabled={verifying || saving}
          />
        </label>
      </div>

      {resolved && (
        <div className="rounded-lg border border-primary/25 bg-primary/5 p-4">
          <div className="flex items-center gap-2 text-xs font-bold text-primary">
            <ShieldCheck size={15} /> Bank account verified
          </div>
          <p className="mt-2 text-sm font-bold">{resolved.account_name}</p>
          <p className="text-xs text-on-surface/55">{selectedBank?.name} · •••• {resolved.account_last4}</p>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs leading-relaxed text-on-surface/70">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              className="mt-0.5"
              disabled={saving}
            />
            <span>I confirm this account belongs to me and the verified account name is correct.</span>
          </label>
        </div>
      )}

      {error && <p className="rounded-md bg-error/10 px-3 py-2 text-xs text-error" role="alert">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void verifyAccount()}
          disabled={!selectedBank || !/^\d{10}$/.test(accountNumber) || verifying || saving}
        >
          {verifying ? 'Verifying…' : 'Verify bank account'}
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void saveAccount()}
          disabled={!resolved || !confirmed || saving || verifying}
        >
          {saving ? 'Saving…' : saved ? 'Replace payout account' : 'Save payout account'}
        </button>
      </div>

      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-on-surface/40">
        <Wallet size={14} className="mt-0.5 shrink-0" />
        Your full account number is sent directly to Paystack for verification and is not stored by Campus Plug.
      </p>
    </section>
  )
}
