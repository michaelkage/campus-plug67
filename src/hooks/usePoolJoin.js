import { useState, useCallback } from 'react'

/**
 * usePoolJoin — handles the full pool join flow:
 * 1. Open Paystack for the unit_price
 * 2. On success → call join-pool Edge Function
 * Returns { joining, joinPool }
 */
export function usePoolJoin({ session, user, onSuccess, onError }) {
  const [joining, setJoining] = useState(false)

  const loadPaystack = () =>
    new Promise((resolve, reject) => {
      if (window.PaystackPop) { resolve(); return }
      const s = document.createElement('script')
      s.src = 'https://js.paystack.co/v1/inline.js'
      s.onload = resolve
      s.onerror = () => reject(new Error('Paystack unavailable'))
      document.head.appendChild(s)
    })

  const joinPool = useCallback(async (pool) => {
    if (!session || !user) { onError?.('Please sign in first'); return }
    setJoining(true)

    try {
      await loadPaystack()

      const ref = `POOL-${pool.id.slice(0, 8)}-${Date.now()}`

      // Open Paystack popup
      await new Promise((resolve, reject) => {
        const h = window.PaystackPop.setup({
          key:       import.meta.env.VITE_PAYSTACK_PUBLIC_KEY,
          email:     user.email,
          amount:    pool.unit_price,   // already in kobo
          ref,
          currency:  'NGN',
          metadata: {
            type:    'pool_join',
            pool_id: pool.id,
            user_id: user.id,
          },
          callback: resolve,
          onClose: () => reject(new Error('Payment cancelled')),
        })
        h.openIframe()
      })

      // Payment confirmed — tell Edge Function
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/join-pool`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ pool_id: pool.id, paystack_ref: ref }),
        }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSuccess?.(data)
      return data
    } catch (e) {
      if (e.message !== 'Payment cancelled') onError?.(e.message)
      return null
    } finally {
      setJoining(false)
    }
  }, [session, user, onSuccess, onError])

  return { joining, joinPool }
}
