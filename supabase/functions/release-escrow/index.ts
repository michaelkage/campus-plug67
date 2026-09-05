import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken, isServiceRoleRequest } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const ok=(d:unknown)=>new Response(JSON.stringify(d),{status:200,headers:CORS});
const bad=(m:string,s=400)=>new Response(JSON.stringify({error:m}),{status:s,headers:CORS});
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  if(req.method==="GET"&&new URL(req.url).pathname.endsWith("/ping")) return ok({status:"warm",ts:Date.now(),fn:"release-escrow"});
  if(req.method!=="POST") return bad("Method not allowed",405);
  let body:Record<string,unknown>; try{body=await req.json();}catch{return bad("Invalid JSON");}
  const action=String(body.action??"");
  if(action==="auto_release"){
    if(!isServiceRoleRequest(req)) return bad("Forbidden",403);
    const {data:due,error}=await admin.from("transactions").select("id").eq("status","release_requested").lte("auto_release_at",new Date().toISOString()).limit(100);
    if(error) return bad(error.message,500);
    let released=0; for(const tx of due??[]){const {error:rpcError}=await admin.rpc("process_escrow_action",{p_transaction_id:tx.id,p_action:"auto_release",p_qr_secret:null,p_reason:null});if(!rpcError) released++; else console.error("auto_release failed",tx.id,rpcError.message);}
    return ok({success:true,processed:due?.length??0,released});
  }
  const user=await getAuthenticatedUser(req); if(!user) return bad("Unauthorized",401);
  const token=getBearerToken(req); if(!token) return bad("Unauthorized",401);
  try{const limit=await enforceRateLimitWithToken(token,"escrow-actions",30,60);if(!limit.allowed) return bad("Rate limit exceeded",429);}catch{return bad("Rate limit service unavailable",503);}
  const transactionId=typeof body.transaction_id==='string'?body.transaction_id:""; if(!transactionId) return bad("Missing transaction_id");
  const rpcArgs={p_transaction_id:transactionId,p_action:action,p_qr_secret:typeof body.qr_secret==='string'?body.qr_secret:(typeof body.release_code==='string'?body.release_code:null),p_reason:typeof body.reason==='string'?body.reason:null};
  const {data,error}=await admin.rpc("process_escrow_action",rpcArgs);
  if(error){const message=error.message||"Escrow action failed";const status=/not authorized|only the|invalid release credential|authentication/i.test(message)?403:400;return bad(message,status);}
  return ok(data);
});
