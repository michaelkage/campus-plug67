import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { Database } from '../../types/database'

type Profile = Database['public']['Tables']['profiles']['Row']
type PlugCreditLedger = Database['public']['Tables']['plug_credit_ledger']['Row']

interface WalletDashboardProps {
  userId: string
}

export default function WalletDashboard({ userId }: WalletDashboardProps) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [transactions, setTransactions] = useState<PlugCreditLedger[]>([])
  const [loading, setLoading] = useState(true)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [showModal, setShowModal] = useState(false)
  const [modalType, setModalType] = useState<'transfer' | 'deposit' | 'payout' | null>(null)
  const [transferAmount, setTransferAmount] = useState('')
  const [recipientId, setRecipientId] = useState('')
  const [transferReason, setTransferReason] = useState('')
  const [processing, setProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const itemsPerPage = 10

  useEffect(() => {
    fetchProfile()
    fetchTransactions(1)
  }, [userId])

  const fetchProfile = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()

      if (error) throw error
      setProfile(data)
    } catch (err) {
      console.error('Error fetching profile:', err)
      setError('Failed to load wallet data')
    }
  }

  const fetchTransactions = async (page: number) => {
    try {
      setLoading(true)
      const from = (page - 1) * itemsPerPage
      const to = from + itemsPerPage - 1

      const { data, error, count } = await supabase
        .from('plug_credit_ledger')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .range(from, to)

      if (error) throw error

      setTransactions(data || [])
      setTotalPages(Math.ceil((count || 0) / itemsPerPage))
      setCurrentPage(page)
    } catch (err) {
      console.error('Error fetching transactions:', err)
      setError('Failed to load transactions')
    } finally {
      setLoading(false)
    }
  }

  const formatNaira = (koboAmount: bigint | number): string => {
    const amount = typeof koboAmount === 'bigint' ? Number(koboAmount) : koboAmount
    const naira = amount / 100
    return new Intl.NumberFormat('en-NG', {
      style: 'currency',
      currency: 'NGN',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(naira)
  }

  const handleTransfer = async () => {
    try {
      setProcessing(true)
      setError(null)

      const amountKobo = Math.round(parseFloat(transferAmount) * 100)

      if (amountKobo <= 0) {
        throw new Error('Invalid amount')
      }

      if (!recipientId) {
        throw new Error('Recipient ID is required')
      }

      if (profile && profile.balance < amountKobo) {
        throw new Error('Insufficient balance')
      }

      const { error: transferError } = await supabase
        .from('plug_credit_ledger')
        .insert({
          user_id: userId,
          amount: -amountKobo,
          reason: transferReason || 'Transfer to user ' + recipientId,
          reference_id: recipientId,
        })

      if (transferError) throw transferError

      const { error: recipientError } = await supabase
        .from('plug_credit_ledger')
        .insert({
          user_id: recipientId,
          amount: amountKobo,
          reason: 'Transfer from user ' + userId,
          reference_id: userId,
        })

      if (recipientError) throw recipientError

      setSuccess('Transfer completed successfully')
      setTransferAmount('')
      setRecipientId('')
      setTransferReason('')
      setShowModal(false)
      fetchProfile()
      fetchTransactions(currentPage)
    } catch (err: any) {
      setError(err.message || 'Transfer failed')
    } finally {
      setProcessing(false)
    }
  }

  const handlePageChange = (page: number) => {
    fetchTransactions(page)
  }

  const getTransactionColor = (amount: bigint | number) => {
    const value = typeof amount === 'bigint' ? Number(amount) : amount
    return value > 0 ? 'text-green-400' : 'text-red-400'
  }

  const getTransactionSign = (amount: bigint | number) => {
    const value = typeof amount === 'bigint' ? Number(amount) : amount
    return value > 0 ? '+' : ''
  }

  return (
    <div className="w-full">
      <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-xl font-bold text-white mb-1">WALLET DASHBOARD</h2>
            <p className="text-xs text-[#666] font-mono tracking-widest">PLUG CREDIT SYSTEM</p>
          </div>
          <button
            onClick={() => {
              setModalType('transfer')
              setShowModal(true)
            }}
            className="px-4 py-2 bg-[#1a1a1a] border border-[#333] text-white text-sm font-mono hover:border-[#00ff88] hover:text-[#00ff88] transition-all"
          >
            NEW TRANSFER
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-800 text-red-400 text-sm font-mono">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-4 p-3 bg-green-900/20 border border-green-800 text-green-400 text-sm font-mono">
            {success}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-[#111] border border-[#222] p-4 rounded">
            <p className="text-xs text-[#666] font-mono mb-2">CURRENT BALANCE</p>
            <p className="text-2xl font-bold text-white font-mono">
              {profile ? formatNaira(profile.balance) : '₦0.00'}
            </p>
          </div>
          <div className="bg-[#111] border border-[#222] p-4 rounded">
            <p className="text-xs text-[#666] font-mono mb-2">TOTAL TRANSACTIONS</p>
            <p className="text-2xl font-bold text-white font-mono">
              {transactions.length}
            </p>
          </div>
          <div className="bg-[#111] border border-[#222] p-4 rounded">
            <p className="text-xs text-[#666] font-mono mb-2">ACCOUNT STATUS</p>
            <p className="text-2xl font-bold text-green-400 font-mono">
              ACTIVE
            </p>
          </div>
        </div>

        <div className="border border-[#1a1a1a] rounded overflow-hidden">
          <div className="bg-[#111] px-4 py-3 border-b border-[#1a1a1a]">
            <h3 className="text-sm font-bold text-white font-mono tracking-widest">TRANSACTION HISTORY</h3>
          </div>

          {loading ? (
            <div className="p-8 text-center text-[#666] font-mono text-sm">
              LOADING TRANSACTION DATA...
            </div>
          ) : transactions.length === 0 ? (
            <div className="p-8 text-center text-[#666] font-mono text-sm">
              NO TRANSACTIONS FOUND
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-[#0f0f0f]">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-mono text-[#888] border-b border-[#1a1a1a]">DATE</th>
                    <th className="px-4 py-3 text-left text-xs font-mono text-[#888] border-b border-[#1a1a1a]">REASON</th>
                    <th className="px-4 py-3 text-left text-xs font-mono text-[#888] border-b border-[#1a1a1a]">REFERENCE</th>
                    <th className="px-4 py-3 text-right text-xs font-mono text-[#888] border-b border-[#1a1a1a]">AMOUNT</th>
                    <th className="px-4 py-3 text-right text-xs font-mono text-[#888] border-b border-[#1a1a1a]">BALANCE</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((tx) => (
                    <tr key={tx.id} className="border-b border-[#1a1a1a] hover:bg-[#111] transition-colors">
                      <td className="px-4 py-3 text-sm text-[#aaa] font-mono">
                        {new Date(tx.created_at).toLocaleDateString('en-NG', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit'
                        })}
                      </td>
                      <td className="px-4 py-3 text-sm text-white font-mono max-w-xs truncate">
                        {tx.reason}
                      </td>
                      <td className="px-4 py-3 text-sm text-[#888] font-mono">
                        {tx.reference_id || 'N/A'}
                      </td>
                      <td className={`px-4 py-3 text-sm text-right font-mono ${getTransactionColor(tx.amount)}`}>
                        {getTransactionSign(tx.amount)}{formatNaira(tx.amount)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-[#aaa] font-mono">
                        {formatNaira(tx.balance_after)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {totalPages > 1 && (
                <div className="flex items-center justify-between px-4 py-3 bg-[#0f0f0f] border-t border-[#1a1a1a]">
                  <span className="text-xs text-[#666] font-mono">
                    PAGE {currentPage} OF {totalPages}
                  </span>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handlePageChange(currentPage - 1)}
                      disabled={currentPage === 1}
                      className="px-3 py-1 bg-[#1a1a1a] border border-[#333] text-white text-xs font-mono hover:border-[#00ff88] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      PREV
                    </button>
                    <button
                      onClick={() => handlePageChange(currentPage + 1)}
                      disabled={currentPage === totalPages}
                      className="px-3 py-1 bg-[#1a1a1a] border border-[#333] text-white text-xs font-mono hover:border-[#00ff88] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      NEXT
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4">
          <div className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-6 w-full max-w-md">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-bold text-white font-mono">
                {modalType === 'transfer' && 'TRANSFER PLUG CREDITS'}
                {modalType === 'deposit' && 'DEPOSIT FUNDS'}
                {modalType === 'payout' && 'REQUEST PAYOUT'}
              </h3>
              <button
                onClick={() => setShowModal(false)}
                className="text-[#666] hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>

            {modalType === 'transfer' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-xs text-[#888] font-mono mb-2">AMOUNT (₦)</label>
                  <input
                    type="number"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    className="w-full bg-[#111] border border-[#333] text-white px-4 py-2 font-mono text-sm focus:border-[#00ff88] focus:outline-none transition-colors"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#888] font-mono mb-2">RECIPIENT USER ID</label>
                  <input
                    type="text"
                    value={recipientId}
                    onChange={(e) => setRecipientId(e.target.value)}
                    className="w-full bg-[#111] border border-[#333] text-white px-4 py-2 font-mono text-sm focus:border-[#00ff88] focus:outline-none transition-colors"
                    placeholder="Enter recipient ID"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#888] font-mono mb-2">REASON (OPTIONAL)</label>
                  <input
                    type="text"
                    value={transferReason}
                    onChange={(e) => setTransferReason(e.target.value)}
                    className="w-full bg-[#111] border border-[#333] text-white px-4 py-2 font-mono text-sm focus:border-[#00ff88] focus:outline-none transition-colors"
                    placeholder="Transfer description"
                  />
                </div>
                <div className="pt-4 flex gap-3">
                  <button
                    onClick={() => setShowModal(false)}
                    className="flex-1 px-4 py-2 bg-[#1a1a1a] border border-[#333] text-white text-sm font-mono hover:border-[#666] transition-all"
                  >
                    CANCEL
                  </button>
                  <button
                    onClick={handleTransfer}
                    disabled={processing || !transferAmount || !recipientId}
                    className="flex-1 px-4 py-2 bg-[#00ff88] border border-[#00ff88] text-black text-sm font-mono hover:bg-[#00cc6a] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                  >
                    {processing ? 'PROCESSING...' : 'CONFIRM TRANSFER'}
                  </button>
                </div>
              </div>
            )}

            {modalType === 'deposit' && (
              <div className="text-center py-8">
                <p className="text-[#666] font-mono text-sm mb-4">DEPOSIT FUNCTIONALITY COMING SOON</p>
                <button
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 bg-[#1a1a1a] border border-[#333] text-white text-sm font-mono hover:border-[#00ff88] transition-all"
                >
                  CLOSE
                </button>
              </div>
            )}

            {modalType === 'payout' && (
              <div className="text-center py-8">
                <p className="text-[#666] font-mono text-sm mb-4">PAYOUT FUNCTIONALITY COMING SOON</p>
                <button
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 bg-[#1a1a1a] border border-[#333] text-white text-sm font-mono hover:border-[#00ff88] transition-all"
                >
                  CLOSE
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}