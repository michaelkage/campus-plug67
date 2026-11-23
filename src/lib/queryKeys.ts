/**
 * Canonical React Query keys.
 *
 * Existing key shapes are preserved for cache compatibility. New domains use
 * hierarchical keys; components should not invent inline arrays.
 */
export const queryKeys = {
  listingDetail: (id: string) => ['listing', id] as const,
  profiles: {
    all: ['profiles'] as const,
    detail: (id: string) => ['profiles', id] as const,
  },
  listings: {
    all: ['listings'] as const,
    detail: (id: string) => ['listings', id] as const,
    marketplace: (university?: string) => ['listings', 'marketplace', university ?? 'all'] as const,
    marketplaceFeed: (filters: { category: string; hostel: string; myOnly: boolean; verifiedOnly: boolean; userId: string; university: string; search?: string; sort?: string; page?: number }) =>
      filters.search || (filters.sort && filters.sort !== 'newest') || (filters.page ?? 0) > 0
        ? ['listings', filters.category, filters.hostel, filters.myOnly, filters.verifiedOnly, filters.userId, filters.university, filters.search ?? '', filters.sort ?? 'newest', filters.page ?? 0] as const
        : ['listings', filters.category, filters.hostel, filters.myOnly, filters.verifiedOnly, filters.userId, filters.university] as const,
    marketplaceFiltered: (filters: { institutionId?: string; category?: string; search?: string; sort?: string } = {}) =>
      ['listings', 'marketplace-filtered', filters] as const,
    bySeller: (sellerId: string) => ['listings', 'seller', sellerId] as const,
  },
  transactions: {
    all: ['transactions'] as const,
    detail: (id: string) => ['transactions', id] as const,
    history: (userId: string) => ['transactions', 'history', userId] as const,
  },
  wallet: {
    all: ['wallet'] as const,
    balance: (userId: string) => ['wallet', 'balance', userId] as const,
    ledger: (userId: string, cursor?: string | null) => cursor
      ? ['wallet', 'ledger', userId, cursor] as const
      : ['wallet', 'ledger', userId] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    user: (userId: string) => ['notifications', userId] as const,
    unreadCount: (userId: string) => ['notifications', 'unread-count', userId] as const,
  },
  messages: {
    all: ['messages'] as const,
    transaction: (transactionId: string) => ['messages', 'transaction', transactionId] as const,
    conversation: (conversationId: string) => ['messages', 'conversation', conversationId] as const,
  },
  conversations: {
    all: ['conversations'] as const,
    inbox: (userId: string) => ['conversations', 'inbox', userId] as const,
    detail: (conversationId: string) => ['conversations', 'detail', conversationId] as const,
    unreadCount: (userId: string) => ['conversations', 'unread-count', userId] as const,
  },
  rentals: {
    all: ['rentals'] as const,
    detail: (rentalId: string) => ['rentals', 'detail', rentalId] as const,
    renter: (userId: string) => ['rentals', 'renter', userId] as const,
    owner: (userId: string) => ['rentals', 'owner', userId] as const,
  },
  bookings: {
    all: ['bookings'] as const,
    detail: (bookingId: string) => ['bookings', 'detail', bookingId] as const,
    customer: (userId: string) => ['bookings', 'customer', userId] as const,
    provider: (userId: string) => ['bookings', 'provider', userId] as const,
  },
  institutions: {
    all: ['institutions'] as const,
    directory: ['institutions', 'directory'] as const,
    detail: (institutionId: string) => ['institutions', 'detail', institutionId] as const,
    memberships: (userId: string) => ['institutions', 'memberships', userId] as const,
  },
  trust: {
    profile: (userId: string) => ['trust', 'profile', userId] as const,
    reports: (userId: string) => ['trust', 'reports', userId] as const,
  },
  search: {
    listings: (query: string, filters: Record<string, unknown> = {}) =>
      ['search', 'listings', query, filters] as const,
  },
} as const

export type QueryKeyFactory = typeof queryKeys
