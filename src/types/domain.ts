import type { Database } from './database'

export type Listing = Database['public']['Tables']['listings']['Row']
export type Profile = Database['public']['Tables']['profiles']['Row']
export type PlugCreditLedgerEntry = Database['public']['Tables']['plug_credit_ledger']['Row']

export type ChatEvidenceMessage = {
  id?: string
  sender_id: string
  body: string | null
  created_at: string
  is_system?: boolean | null
  flagged?: boolean | null
  flag_type?: string | null
  is_claimant?: boolean
}

export type JuryCase = {
  id: string
  claimant_id: string
  respondent_id: string
  dispute_reason: string
  amount: number
  required_votes: number
  created_at: string
  high_value: boolean
  evidence_messages?: ChatEvidenceMessage[] | null
}

export type WalletTransferResult = {
  success?: boolean
  transaction_id?: string
  new_balance?: number
  [key: string]: unknown
}
