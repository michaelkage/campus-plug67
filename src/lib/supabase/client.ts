import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    '[CampusPlug] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY.\n' +
    'Copy .env.example → .env and fill in your Supabase project credentials.'
  )
}

export interface RpcDefinitions {
  get_price_floor: {
    Args: { p_category: string; p_university: string }
    Returns: {
      floor_price: number
      median_price: number | null
      q1_price: number | null
      q3_price: number | null
      iqr: number
      has_floor: boolean
    }
  }
  provision_my_emergency_tokens: {
    Args: Record<string, never>
    Returns: number
  }
  get_price_suggestion: {
    Args: { p_category: string; p_university: string }
    Returns: unknown
  }
  get_market_intelligence: {
    Args: { p_category: string; p_university: string }
    Returns: unknown
  }
  transfer_plug_credit: {
    Args: { p_recipient_id: string; p_amount: number; p_reason?: string | null }
    Returns: { success?: boolean; [key: string]: unknown }
  }
  create_wallet_micro_escrow: {
    Args: { p_listing_id: string }
    Returns: { success?: boolean; [key: string]: unknown }
  }
  increment_spoof_flag: {
    Args: { p_user_id: string }
    Returns: unknown
  }
  get_department_leaderboard: {
    Args: { p_university: string }
    Returns: unknown
  }
  create_session_handoff: {
    Args: { p_transaction_id: string }
    Returns: unknown
  }
  write_security_audit: {
    Args: {
      p_entity_type: string
      p_entity_id: string
      p_action: string
      p_metadata?: Record<string, unknown> | null
    }
    Returns: string
  }
}

type RpcName = keyof RpcDefinitions

type RpcResult<Name extends RpcName> = {
  data: RpcDefinitions[Name]['Returns'] | null
  error: { message: string } | null
}

const rawSupabase = createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'cp_auth',
    flowType: 'pkce',
  },
  realtime: { params: { eventsPerSecond: 12 } },
  global: { headers: { 'x-app-version': '3.1.0' } },
})

type TypedRpcClient = Omit<typeof rawSupabase, 'rpc'> & {
  rpc<Name extends RpcName>(
    name: Name,
    args: RpcDefinitions[Name]['Args'],
  ): Promise<RpcResult<Name>>
  rpc(name: string, args?: Record<string, unknown>): Promise<{
    data: unknown
    error: { message: string } | null
  }>
}

/**
 * The generated schema currently contains tables but no Functions map.
 * Supabase's generic rpc overload consequently collapses arguments to never.
 * Keep the generated Database untouched and provide a narrow typed facade for
 * application RPCs while retaining a generic escape hatch for legacy calls.
 */
export const supabase: TypedRpcClient = rawSupabase as unknown as TypedRpcClient

export { SUPABASE_URL, SUPABASE_ANON_KEY }
