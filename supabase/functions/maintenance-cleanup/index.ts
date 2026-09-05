import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const headers={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
serve(async(req)=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers});
  const auth=req.headers.get('Authorization')||'';
  const service=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  if(!service || auth!==`Bearer ${service}`) return new Response(JSON.stringify({error:'Forbidden'}),{status:403,headers});
  if(req.method!=='POST') return new Response(JSON.stringify({error:'Method not allowed'}),{status:405,headers});
  const url=Deno.env.get('SUPABASE_URL');
  if(!url) return new Response(JSON.stringify({error:'Configuration error'}),{status:500,headers});
  const admin=createClient(url,service,{auth:{persistSession:false}});
  const [{data:retention,error:e1},{data:stale,error:e2}]=await Promise.all([
    admin.rpc('cleanup_phase2_17_data'),
    admin.rpc('cleanup_stale_idempotency_keys'),
  ]);
  if(e1||e2) return new Response(JSON.stringify({error:e1?.message||e2?.message}),{status:500,headers});
  return new Response(JSON.stringify({success:true,retention,stale_idempotency_keys_removed:stale}),{status:200,headers});
});
