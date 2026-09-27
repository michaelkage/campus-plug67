export const queryKeys = {
  profiles: {
    all: ['profiles'] as const,
    detail: (id: string) => ['profiles', id] as const,
  },
  listings: {
    all: ['listings'] as const,
    detail: (id: string) => ['listings', id] as const,
    marketplace: (university?: string) => ['listings', 'marketplace', university ?? 'all'] as const,
  },
  transactions: {
    all: ['transactions'] as const,
    detail: (id: string) => ['transactions', id] as const,
    history: (userId: string) => ['transactions', 'history', userId] as const,
  },
  wallet: {
    all: ['wallet'] as const,
    balance: (userId: string) => ['wallet', 'balance', userId] as const,
    ledger: (userId: string) => ['wallet', 'ledger', userId] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    user: (userId: string) => ['notifications', userId] as const,
  },
  messages: {
    all: ['messages'] as const,
    transaction: (transactionId: string) => ['messages', 'transaction', transactionId] as const,
  },
} as const;
