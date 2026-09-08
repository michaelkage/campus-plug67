import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const ORIGIN=Deno.env.get('APP_ORIGIN')??'https://campusplug.ng';

function isMobile(req:Request){return /android|iphone|ipad|ipod|mobile|windows phone/i.test(req.headers.get('user-agent')||'');}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS') return optionsResponse(req);
  if(req.method!=='POST') return jsonResponse({error:'Method not allowed'},405,{},req);
  if(!isMobile(req)) return jsonResponse({error:'Session handoff must be completed on a mobile device.',code:'MOBILE_REQUIRED'},403,{},req);
  const body=await req.json().catch(()=>null) as Record<string,unknown>|null;
  const token=typeof body?.token==='string'?body.token:'';
  if(!token) return jsonResponse({error:'Missing handoff token'},400,{},req);

  const {data:handoff,error:consumeError}=await admin.rpc('consume_session_handoff',{p_token:token});
  if(consumeError) return jsonResponse({error:'Handoff service unavailable'},503,{},req);
  if(!handoff?.success) return jsonResponse({error:handoff?.error||'Handoff expired or already used'},410,{},req);

  const {data:profile,error:profileError}=await admin.from('profiles').select('email').eq('id',handoff.user_id).single();
  if(profileError||!profile?.email) return jsonResponse({error:'Account session could not be restored'},400,{},req);
  const {data:link,error:linkError}=await admin.auth.admin.generateLink({type:'magiclink',email:profile.email,options:{redirectTo:ORIGIN}});
  if(linkError||!link?.properties?.hashed_token) return jsonResponse({error:'Session generation failed'},400,{},req);
  const {data:session,error:verifyError}=await admin.auth.verifyOtp({token_hash:link.properties.hashed_token,type:'magiclink'});
  if(verifyError||!session?.session) return jsonResponse({error:'Session verification failed'},400,{},req);
  return jsonResponse({success:true,transaction_id:handoff.transaction_id,access_token:session.session.access_token,refresh_token:session.session.refresh_token},200,{},req);
});
