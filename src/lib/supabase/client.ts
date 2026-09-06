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

type LooseTable = {
  Row: Record<string, any>
  Insert: Record<string, any>
  Update: Record<string, any>
}

type LooseFunction = {
  Args: Record<string, any>
  Returns: any
}

type AppDatabase = Database & {
  public: Database['public'] & {
    Tables: Database['public']['Tables'] & Record<string, LooseTable>
    Views: Record<string, LooseTable>
    Functions: Record<string, LooseFunction>
  }
}

export const supabase = createClient<AppDatabase>(SUPABASE_URL, SUPABASE_ANON_KEY, {
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

export { SUPABASE_URL, SUPABASE_ANON_KEY }
