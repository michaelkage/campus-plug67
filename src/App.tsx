/**
 * Campus Plug v6.8.0 — Application Root
 *
 * FIX #9: The old App.tsx was an orphan stripped-down dashboard that bypassed:
 *   - react-router-dom (no routes rendered — all src/pages/* were dead code)
 *   - AuthProvider     (auth state managed locally instead of via context)
 *   - FeatureFlagProvider (feature flags never loaded)
 *   - Layout / TopNav / BottomNav (the full shell was never mounted)
 *
 * This file is now a pure shell that:
 *   1. Wraps the whole tree in QueryClientProvider, AuthProvider, FeatureFlagProvider,
 *      and ThemeProvider.
 *   2. Mounts react-router-dom <BrowserRouter> → <Routes> so all src/pages/* render.
 *   3. Protects authenticated routes with a <PrivateRoute> guard.
 *   4. Keeps a <Toaster> for react-hot-toast notifications.
 *
 * Route layout mirrors the existing BottomNav tabs so navigation is consistent.
 */

import React, { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'

import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { FeatureFlagProvider } from '@/contexts/FeatureFlagContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import Layout from '@/components/layout/Layout'

// ── Lazy-loaded pages ─────────────────────────────────────────────────────────
const Home           = lazy(() => import('@/pages/Home'))
const Marketplace    = lazy(() => import('@/pages/Marketplace'))
const ListingDetail  = lazy(() => import('@/pages/ListingDetail'))
const Gigs           = lazy(() => import('@/pages/Gigs'))
const StudyPools     = lazy(() => import('@/pages/StudyPools'))
const LostFound      = lazy(() => import('@/pages/LostFound'))
const Profile        = lazy(() => import('@/pages/Profile'))
const VerifyProfile  = lazy(() => import('@/pages/VerifyProfile'))
const Leaderboard    = lazy(() => import('@/pages/Leaderboard'))
const Reviews        = lazy(() => import('@/pages/Reviews'))
const Notifications  = lazy(() => import('@/pages/Notifications'))
const WarRoom        = lazy(() => import('@/pages/WarRoom'))
const Auth           = lazy(() => import('@/pages/Auth'))
const OnboardingComplete = lazy(() => import('@/pages/OnboardingComplete'))
const Privacy        = lazy(() => import('@/pages/Privacy'))
const Terms          = lazy(() => import('@/pages/Terms'))

// ── Query client ──────────────────────────────────────────────────────────────
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime:          60_000,
      retry:              1,
      refetchOnWindowFocus: false,
    },
  },
})

// ── Route guard ───────────────────────────────────────────────────────────────
function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location          = useLocation()

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-2 border-[#00ff88] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-[#666] font-mono text-sm tracking-widest">
            INITIALIZING CAMPUS PLUG v68...
          </p>
        </div>
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/auth" state={{ from: location }} replace />
  }

  return <>{children}</>
}

// ── Page loading fallback ─────────────────────────────────────────────────────
function PageLoader() {
  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="w-8 h-8 border-2 border-[#00ff88] border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

// ── Router tree ───────────────────────────────────────────────────────────────
function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Public routes */}
        <Route path="/auth"             element={<Auth />} />
        <Route path="/verify/:id"       element={<VerifyProfile />} />
        <Route path="/privacy"          element={<Privacy />} />
        <Route path="/terms"            element={<Terms />} />
        <Route path="/onboarding/complete" element={<OnboardingComplete />} />

        {/* Authenticated routes — wrapped in Layout (TopNav + BottomNav) */}
        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index                  element={<Home />} />
          <Route path="marketplace"     element={<Marketplace />} />
          <Route path="marketplace/:id" element={<ListingDetail />} />
          <Route path="gigs"            element={<Gigs />} />
          <Route path="study-pools"     element={<StudyPools />} />
          <Route path="lost-found"      element={<LostFound />} />
          <Route path="profile"         element={<Profile />} />
          <Route path="profile/:id"     element={<Profile />} />
          <Route path="leaderboard"     element={<Leaderboard />} />
          <Route path="reviews"         element={<Reviews />} />
          <Route path="notifications"   element={<Notifications />} />
          <Route path="war-room"        element={<WarRoom />} />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}

// ── Root component ────────────────────────────────────────────────────────────
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <FeatureFlagProvider>
            <ThemeProvider>
              <AppRoutes />
              <Toaster
                position="top-right"
                toastOptions={{
                  style: {
                    background: '#1a1a1a',
                    color:      '#fff',
                    border:     '1px solid #333',
                    fontFamily: 'monospace',
                    fontSize:   '13px',
                  },
                  success: { iconTheme: { primary: '#00ff88', secondary: '#0a0a0a' } },
                  error:   { iconTheme: { primary: '#ff4444', secondary: '#0a0a0a' } },
                }}
              />
            </ThemeProvider>
          </FeatureFlagProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
