import React, { Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { FeatureFlagProvider } from '@/contexts/FeatureFlagContext'
import { ThemeProvider } from '@/contexts/ThemeContext'
import Layout from '@/components/layout/Layout'
import ErrorBoundary from '@/components/ErrorBoundary'
import NetworkStatus from '@/components/NetworkStatus'

const Home = lazy(() => import('@/pages/Home'))
const Marketplace = lazy(() => import('@/pages/Marketplace'))
const ListingDetail = lazy(() => import('@/pages/ListingDetail'))
const Gigs = lazy(() => import('@/pages/Gigs'))
const StudyPools = lazy(() => import('@/pages/StudyPools'))
const LostFound = lazy(() => import('@/pages/LostFound'))
const Profile = lazy(() => import('@/pages/Profile'))
const VerifyProfile = lazy(() => import('@/pages/VerifyProfile'))
const Leaderboard = lazy(() => import('@/pages/Leaderboard'))
const Reviews = lazy(() => import('@/pages/Reviews'))
const Notifications = lazy(() => import('@/pages/Notifications'))
const WarRoom = lazy(() => import('@/pages/WarRoom'))
const Auth = lazy(() => import('@/pages/Auth'))
const OnboardingComplete = lazy(() => import('@/pages/OnboardingComplete'))
const Privacy = lazy(() => import('@/pages/Privacy'))
const Terms = lazy(() => import('@/pages/Terms'))
const NotFound = lazy(() => import('@/pages/NotFound'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 60_000, retry: 1, refetchOnWindowFocus: false },
  },
})

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) {
    return (
      <div className="min-h-screen bg-obsidian-950 flex items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-3">
          <div className="skeleton h-3 w-24 mx-auto" />
          <div className="skeleton h-12 w-12 rounded-full mx-auto" />
          <div className="skeleton h-4 w-48 mx-auto" />
        </div>
      </div>
    )
  }
  if (!user) return <Navigate to="/auth" state={{ from: location }} replace />
  return <>{children}</>
}

function PageLoader() {
  return (
    <div className="min-h-screen bg-obsidian-950 p-6 flex items-center justify-center">
      <div className="w-full max-w-2xl space-y-4">
        <div className="skeleton h-10 w-1/3" />
        <div className="skeleton h-28 w-full" />
        <div className="grid grid-cols-2 gap-3"><div className="skeleton h-32" /><div className="skeleton h-32" /></div>
      </div>
    </div>
  )
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <ErrorBoundary>
        <Routes>
          <Route path="/auth" element={<Auth />} />
          <Route path="/verify/:id" element={<VerifyProfile />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/onboarding/complete" element={<OnboardingComplete />} />
          <Route path="/" element={<PrivateRoute><Layout /></PrivateRoute>}>
            <Route index element={<Home />} />
            <Route path="marketplace" element={<Marketplace />} />
            <Route path="marketplace/:id" element={<ListingDetail />} />
            <Route path="gigs" element={<Gigs />} />
            <Route path="study-pools" element={<StudyPools />} />
            <Route path="lost-found" element={<LostFound />} />
            <Route path="profile" element={<Profile />} />
            <Route path="profile/:id" element={<Profile />} />
            <Route path="leaderboard" element={<Leaderboard />} />
            <Route path="reviews" element={<Reviews />} />
            <Route path="notifications" element={<Notifications />} />
            <Route path="war-room" element={<WarRoom />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
    </Suspense>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <FeatureFlagProvider>
            <ThemeProvider>
              <AppRoutes />
              <NetworkStatus />
              <Toaster position="top-right" toastOptions={{
                style: { background: '#121721', color: '#fff', border: '1px solid rgba(255,255,255,.08)', fontFamily: 'monospace', fontSize: '13px' },
              }} />
            </ThemeProvider>
          </FeatureFlagProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
