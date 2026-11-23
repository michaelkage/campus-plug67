import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { queryKeys } from '@/lib/queryKeys'

export type WorkspaceTransaction = {
  id: string
  buyer_id: string
  seller_id: string
  listing_id: string | null
  amount: number
  status: string
  escrow_status: string
  created_at: string
  updated_at: string
}

export type WorkspaceBooking = {
  id: string
  client_id: string
  seller_id: string
  status: string
  slot_date: string
  slot_time: string
  amount: number | null
  created_at: string | null
  gigs?: { title?: string | null } | null
}

export type WorkspaceRental = {
  id: string
  listing_id: string
  borrower_id: string
  lender_id: string
  rental_status: string
  start_date: string | null
  end_date: string | null
  rental_fee_kobo: number | null
  total_held_kobo: number | null
  created_at: string
}

export type WorkspaceListing = {
  id: string
  title: string
  status: string
  price: number
  created_at: string
}

export type StudentWorkspaceData = {
  transactions: WorkspaceTransaction[]
  bookings: WorkspaceBooking[]
  rentals: WorkspaceRental[]
  listings: WorkspaceListing[]
  unreadNotifications: number
  unreadMessages: number
  activeListingCount: number
  pendingSalesCount: number
  pendingPurchasesCount: number
}

async function fetchStudentWorkspace(userId: string): Promise<StudentWorkspaceData> {
  const [transactions, bookings, rentals, listings, notifications, messages] = await Promise.all([
    supabase.from('transactions')
      .select('id,buyer_id,seller_id,listing_id,amount,status,escrow_status,created_at,updated_at')
      .or(`buyer_id.eq.${userId},seller_id.eq.${userId}`)
      .order('updated_at', { ascending: false }).limit(12),
    supabase.from('gig_bookings')
      .select('id,client_id,seller_id,status,slot_date,slot_time,amount,created_at,gigs(title)')
      .or(`client_id.eq.${userId},seller_id.eq.${userId}`)
      .order('created_at', { ascending: false }).limit(8),
    supabase.from('gear_rentals')
      .select('id,listing_id,borrower_id,lender_id,rental_status,start_date,end_date,rental_fee_kobo,total_held_kobo,created_at')
      .or(`borrower_id.eq.${userId},lender_id.eq.${userId}`)
      .order('created_at', { ascending: false }).limit(8),
    supabase.from('listings')
      .select('id,title,status,price,created_at')
      .eq('seller_id', userId)
      .order('created_at', { ascending: false }).limit(8),
    supabase.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId).eq('read', false),
    supabase.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('receiver_id', userId).eq('read', false),
  ])

  const results = [transactions, bookings, rentals, listings, notifications, messages]
  const failed = results.find(result => result.error)
  if (failed?.error) throw failed.error

  const transactionRows = transactions.data ?? []
  return {
    transactions: transactionRows,
    bookings: bookings.data ?? [],
    rentals: rentals.data ?? [],
    listings: listings.data ?? [],
    unreadNotifications: notifications.count ?? 0,
    unreadMessages: messages.count ?? 0,
    activeListingCount: (listings.data ?? []).filter(row => row.status === 'active').length,
    pendingSalesCount: transactionRows.filter(row => row.seller_id === userId && row.status !== 'cancelled' && !['released', 'refunded'].includes(row.escrow_status)).length,
    pendingPurchasesCount: transactionRows.filter(row => row.buyer_id === userId && row.status !== 'cancelled' && !['released', 'refunded'].includes(row.escrow_status)).length,
  }
}

export function useStudentWorkspace(userId?: string) {
  return useQuery({
    queryKey: queryKeys.workspace.overview(userId ?? ''),
    queryFn: () => fetchStudentWorkspace(userId!),
    enabled: Boolean(userId),
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
}
