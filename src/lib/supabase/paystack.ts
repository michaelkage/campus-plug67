import { SUPABASE_ANON_KEY, SUPABASE_URL, supabase } from './client'

export interface PaystackMetadata {
  [key: string]: string | number | boolean | null | undefined
}

export interface PaystackTransactionOptions {
  email: string
  amount: number
  ref: string
  publicKey: string
  metadata?: PaystackMetadata
  currency?: string
}

export interface PaystackCallbackResponse {
  reference: string
  status: string
  trans?: string
  message?: string
}

interface PaystackHandler {
  openIframe: () => void
}

interface PaystackPop {
  setup: (options: {
    key: string
    email: string
    amount: number
    ref: string
    currency: string
    metadata: PaystackMetadata
    callback: (response: PaystackCallbackResponse) => void
    onClose: () => void
  }) => PaystackHandler
}

declare global {
  interface Window {
    PaystackPop?: PaystackPop
  }
}

export function openPaystack(options: PaystackTransactionOptions): Promise<PaystackCallbackResponse> {
  const { email, amount, ref, publicKey, metadata = {}, currency = 'NGN' } = options
  return new Promise((resolve, reject) => {
    const init = () => {
      const paystack = window.PaystackPop
      if (!paystack) {
        reject(new Error('Paystack is unavailable. Check your connection.'))
        return
      }
      const handler = paystack.setup({
        key: publicKey,
        email,
        amount,
        ref,
        currency,
        metadata,
        callback: resolve,
        onClose: () => reject(new Error('Payment cancelled')),
      })
      handler.openIframe()
    }

    if (window.PaystackPop) {
      init()
      return
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-paystack-inline]')
    if (existing) {
      existing.addEventListener('load', init, { once: true })
      existing.addEventListener('error', () => reject(new Error('Failed to load Paystack. Check your connection.')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.src = 'https://js.paystack.co/v1/inline.js'
    script.async = true
    script.dataset.paystackInline = 'true'
    script.onload = init
    script.onerror = () => reject(new Error('Failed to load Paystack. Check your connection.'))
    document.head.appendChild(script)
  })
}

export function generatePaystackRef(prefix = 'CP'): string {
  return `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
}

export type AllowedEdgeFunctionName =
  | 'release-escrow'
  | 'ai-chat-scan'
  | 'beacon-matcher'
  | 'security-gate'

export interface EdgeFunctionResult<T> {
  data: T | null
  error: string | null
}

export async function callEdgeFunction<T = unknown>(
  functionName: AllowedEdgeFunctionName,
  body: unknown,
  accessToken?: string,
): Promise<EdgeFunctionResult<T>> {
  const token = accessToken ?? (await supabase.auth.getSession()).data.session?.access_token
  if (!token) return { data: null, error: 'Not authenticated' }

  try {
    const { data, error } = await supabase.functions.invoke<T>(functionName, {
      body,
      headers: { Authorization: `Bearer ${token}` },
    })
    if (error) return { data: null, error: error.message || 'Edge function error' }
    return { data, error: null }
  } catch {
    try {
      const response = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body),
      })
      const data: unknown = await response.json().catch(() => ({}))
      if (!response.ok) {
        const message = typeof data === 'object' && data !== null && 'error' in data
          ? String(data.error)
          : `HTTP ${response.status}`
        return { data: null, error: message }
      }
      return { data: data as T, error: null }
    } catch (error: unknown) {
      return {
        data: null,
        error: error instanceof Error ? error.message : 'Network error',
      }
    }
  }
}

export async function pingEdgeFunction(functionName: AllowedEdgeFunctionName): Promise<{ warm: boolean; latencyMs: number }> {
  const url = `${SUPABASE_URL}/functions/v1/${functionName}/ping`
  const start = Date.now()
  try {
    const response = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      signal: AbortSignal.timeout(5000),
    })
    return { warm: response.ok, latencyMs: Date.now() - start }
  } catch {
    return { warm: false, latencyMs: Date.now() - start }
  }
}
