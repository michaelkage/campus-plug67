-- ============================================================
-- Campus Plug — Migration: Security & Remote Schema Features
-- Phase 3 Infrastructure Fixes
-- ============================================================

-- 1. Enable pg_trgm for fuzzy matching text
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 2. Chat Flag Log table for the semantic AI scanner
CREATE TABLE IF NOT EXISTS public.chat_flag_log (
    id uuid DEFAULT uuid_generate_v4() PRIMARY KEY,
    sender_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    listing_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
    message_hash text NOT NULL,
    flag_type text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
    action_taken text NOT NULL CHECK (action_taken IN ('warned', 'blocked')),
    created_at timestamptz DEFAULT now()
);

-- Protect chat flag logs from tampering
ALTER TABLE public.chat_flag_log ENABLE ROW LEVEL SECURITY;

-- Admins / Services can read
CREATE POLICY "Service and admins can read chat logs" ON public.chat_flag_log
    FOR SELECT USING (auth.role() = 'service_role');

-- Users can only insert
CREATE POLICY "Users can insert their own chat logs" ON public.chat_flag_log
    FOR INSERT WITH CHECK (auth.uid() = sender_id);
