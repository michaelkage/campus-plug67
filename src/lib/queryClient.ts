import { QueryClient } from '@tanstack/react-query'

/**
 * One application-wide cache instance.
 *
 * Keeping construction outside React prevents accidental cache replacement
 * during hot reloads, route transitions, or future provider composition.
 * Domain-specific invalidation belongs in repository/mutation modules, not pages.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
})
