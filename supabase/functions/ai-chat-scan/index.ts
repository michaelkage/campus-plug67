import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Payment diversion patterns (Nigeria-specific)
const PAYMENT_PATTERNS = [
  /bank\s*transfer/i,
  /account\s*number/i,
  /sort\s*code/i,
  /send\s*money/i,
  /wire\s*transfer/i,
  /western\s*union/i,
  /moneygram/i,
  /070\d{8}|080\d{8}|081\d{8}|090\d{8}/, // Nigerian phone numbers
  /\b\d{10,12}\b/, // Potential account numbers
  /pay\s*directly/i,
  /outside\s*campus\s*plug/i,
  /off\s*platform/i,
  /avoid\s*fees/i,
  /cash\s*payment/i,
  /bank\s*deposit/i,
  /transfer\s*to/i,
]

// Inappropriate content patterns
const CONTENT_MODERATION_PATTERNS = [
  /\b(nude|naked|sex|porn|xxx|adult)\b/i,
  /\b(drugs|weed|cocaine|heroin)\b/i,
  /\b(weapon|gun|knife|bomb)\b/i,
  /\b(scam|fraud|rip\s*off)\b/i,
  /\b(kill|murder|death|die)\b/i,
]

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { message_id, sender_id, receiver_id, content, chat_type } = await req.json()

    if (!message_id || !content) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let flagged = false
    let flag_type = null
    let confidence = 0
    let matched_patterns = []

    // Check for payment diversion
    for (const pattern of PAYMENT_PATTERNS) {
      if (pattern.test(content)) {
        flagged = true
        flag_type = 'payment_diversion'
        confidence = Math.max(confidence, 0.8)
        matched_patterns.push(pattern.toString())
      }
    }

    // Check for inappropriate content
    for (const pattern of CONTENT_MODERATION_PATTERNS) {
      if (pattern.test(content)) {
        flagged = true
        flag_type = flag_type || 'inappropriate_content'
        confidence = Math.max(confidence, 0.7)
        matched_patterns.push(pattern.toString())
      }
    }

    // Log the scan result
    const { error: logError } = await supabaseClient.from('chat_scan_logs').insert({
      message_id,
      sender_id,
      receiver_id,
      content,
      chat_type,
      flagged,
      flag_type,
      confidence,
      matched_patterns: matched_patterns.join(', '),
      scanned_at: new Date().toISOString()
    })

    if (logError) {
      console.error('Error logging chat scan:', logError)
    }

    // If flagged, create chat flag entry
    if (flagged) {
      const { error: flagError } = await supabaseClient.from('chat_flag_log').insert({
        message_id,
        sender_id,
        receiver_id,
        flag_type,
        confidence,
        severity: confidence > 0.8 ? 'high' : 'medium',
        status: 'pending_review',
        metadata: { matched_patterns }
      })

      if (flagError) {
        console.error('Error creating chat flag:', flagError)
      }

      // Auto-flag user for high-severity violations
      if (confidence > 0.9) {
        await supabaseClient.from('user_security').insert({
          user_id: sender_id,
          flag_type: 'chat_violation',
          severity: 'critical',
          description: `High-confidence ${flag_type} detected in chat`,
          metadata: { message_id, patterns: matched_patterns }
        })
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        flagged,
        flag_type,
        confidence,
        message: flagged ? 'Message flagged for review' : 'Message passed safety check'
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})