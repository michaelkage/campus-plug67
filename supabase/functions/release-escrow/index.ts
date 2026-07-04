import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseClient = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    )

    const { transaction_id, release_code, action } = await req.json()

    if (!transaction_id || !action) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify transaction exists and get details
    const { data: transaction, error: txError } = await supabaseClient
      .from('transactions')
      .select('*')
      .eq('id', transaction_id)
      .single()

    if (txError || !transaction) {
      return new Response(
        JSON.stringify({ error: 'Transaction not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Verify escrow status
    if (transaction.escrow_status !== 'held') {
      return new Response(
        JSON.stringify({ error: 'Escrow not in held status' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    let newStatus, userId, amount

    if (action === 'release') {
      // Release to seller
      if (transaction.release_code !== release_code) {
        return new Response(
          JSON.stringify({ error: 'Invalid release code' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      newStatus = 'completed'
      userId = transaction.seller_id
      amount = transaction.amount

      // Update transaction
      const { error: updateError } = await supabaseClient
        .from('transactions')
        .update({
          status: newStatus,
          escrow_status: 'released',
          released_at: new Date().toISOString()
        })
        .eq('id', transaction_id)

      if (updateError) throw updateError

      // Create ledger entry (trigger will handle balance update)
      const { error: ledgerError } = await supabaseClient
        .from('plug_credit_ledger')
        .insert({
          user_id: userId,
          amount: amount,
          reason: 'Escrow release for transaction #' + transaction_id,
          reference_id: transaction_id
        })

      if (ledgerError) throw ledgerError

    } else if (action === 'refund') {
      // Refund to buyer
      newStatus = 'cancelled'
      userId = transaction.buyer_id
      amount = transaction.amount

      const { error: updateError } = await supabaseClient
        .from('transactions')
        .update({
          status: newStatus,
          escrow_status: 'refunded',
          cancelled_at: new Date().toISOString()
        })
        .eq('id', transaction_id)

      if (updateError) throw updateError

      const { error: ledgerError } = await supabaseClient
        .from('plug_credit_ledger')
        .insert({
          user_id: userId,
          amount: amount,
          reason: 'Refund for cancelled transaction #' + transaction_id,
          reference_id: transaction_id
        })

      if (ledgerError) throw ledgerError

    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid action' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Log the action
    await supabaseClient.from('audit_logs').insert({
      user_id: userId,
      action: `escrow_${action}`,
      entity_type: 'transaction',
      entity_id: transaction_id,
      metadata: { previous_status: transaction.status, new_status: newStatus }
    })

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Escrow ${action} successful`,
        transaction_id,
        new_status: newStatus
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