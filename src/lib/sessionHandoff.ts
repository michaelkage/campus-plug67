import { supabase } from './supabase'

export async function createSessionHandoff(transactionId:string){
  const {data,error}=await (supabase.rpc as any)('create_session_handoff',{p_transaction_id:transactionId})
  if(error) throw error
  const responseData = data as { token?: string } | null
  if (!responseData || !responseData.token) { throw new Error('Unable to create mobile handoff'); }
  return responseData as {token:string;expires_at:string;handoff_id:string;transaction_id:string|null}
}

export async function consumeSessionHandoff(token:string){
  const {data,error}=await supabase.functions.invoke('session-handoff',{body:{token}})
  if(error) throw error
  if(!data?.access_token||!data?.refresh_token) throw new Error(data?.error||'Mobile handoff failed')
  const {data:session,error:sessionError}=await supabase.auth.setSession({access_token:data.access_token,refresh_token:data.refresh_token})
  if(sessionError) throw sessionError
  return {transactionId:data.transaction_id as string|null,session}
}
