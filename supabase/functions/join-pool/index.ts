import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser,getBearerToken } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const ok=(d:unknown)=>new Response(JSON.stringify(d),{status:200,headers:CORS});
const bad=(m:string,s=400)=>new Response(JSON.stringify({error:m}),{status:s,headers:CORS});
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

function isTransientConcurrencyError(message:string){
 const m=message.toLowerCase();
 return m.includes('deadlock') || m.includes('serialization') || m.includes('statement timeout') || m.includes('could not serialize');
}

async function verifyPaystackPayment(reference:string, expectedAmountKobo:number, poolId:string, userId:string){
 const secret=Deno.env.get("PAYSTACK_SECRET_KEY");
 if(!secret) return {ok:false as const, reason:"payment_config_missing"};
 const res=await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,{
  headers:{Authorization:`Bearer ${secret}`,Accept:"application/json"},
 });
 if(!res.ok) return {ok:false as const, reason:"payment_verify_failed"};
 const json=await res.json();
 const data=json?.data;
 if(!json?.status || data?.status!=="success") return {ok:false as const, reason:"payment_not_successful"};
 if(Number(data.amount)!==Number(expectedAmountKobo)) return {ok:false as const, reason:"payment_amount_mismatch"};
 const meta=data.metadata??{};
 if(meta.type && meta.type!=="pool_join") return {ok:false as const, reason:"payment_type_mismatch"};
 if(meta.pool_id && meta.pool_id!==poolId) return {ok:false as const, reason:"payment_pool_mismatch"};
 if(meta.user_id && meta.user_id!==userId) return {ok:false as const, reason:"payment_user_mismatch"};
 return {ok:true as const};
}

async function atomicJoin(poolId:string,userId:string,paystackRef:string|null){
 for(let attempt=0;attempt<3;attempt++){
  const {data,error}=await admin.rpc("atomic_pool_join",{p_pool_id:poolId,p_user_id:userId,p_ref:paystackRef});
  if(!error) return {data,error:null};
  if(!isTransientConcurrencyError(error.message)||attempt===2) return {data:null,error};
  await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
 }
 return {data:null,error:new Error('Pool join contention')};
}

serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 if(req.method==="GET"&&new URL(req.url).pathname.endsWith("/ping"))return ok({status:"warm",ts:Date.now(),fn:"join-pool"});
 if(req.method!=="POST")return bad("Method not allowed",405);
 const user=await getAuthenticatedUser(req);if(!user)return bad("Unauthorized",401);
 const token=getBearerToken(req);if(!token)return bad("Unauthorized",401);
 try{const limit=await enforceRateLimitWithToken(token,"study-pool-joins",20,60);if(!limit.allowed)return bad("Rate limit exceeded",429);}catch{return bad("Rate limit service unavailable",503);}
 let body:Record<string,any>;try{body=await req.json();}catch{return bad("Invalid JSON");}
 const poolId=typeof body.pool_id==="string"?body.pool_id:"";const paystackRef=typeof body.paystack_ref==="string"?body.paystack_ref:null;if(!poolId)return bad("Missing pool_id");

 const {data:poolRow,error:poolErr}=await admin.from("study_pools").select("id,unit_price,payment_refs,status").eq("id",poolId).maybeSingle();
 if(poolErr) return bad("Unable to load pool",503);
 if(!poolRow) return bad("pool_not_found",404);
 if(poolRow.status!=="open") return bad("pool_closed",400);

 const price=Number(poolRow.unit_price??0);
 if(price>0){
  if(!paystackRef) return bad("Missing paystack_ref",400);
  const refs=poolRow.payment_refs??[];
  if(Array.isArray(refs) && refs.includes(paystackRef)) return bad("payment_already_used",409);
  const verified=await verifyPaystackPayment(paystackRef, price, poolId, user.id);
  if(!verified.ok) return bad(verified.reason,402);
 }

 const {data,error:resultError}=await atomicJoin(poolId,user.id,paystackRef);
 if(resultError)return bad("Pool is busy; please retry",503);if(!data?.success){const reason=data?.reason;const status=reason==="pool_not_found"?404:reason==="pool_full"||reason==="already_joined"||reason==="join_conflict"?409:400;return bad(reason??"Unable to join pool",status);}
 const pool=data.pool;const {data:profile}=await admin.from("profiles").select("full_name").eq("id",user.id).single();
 await admin.from("activity_feed").insert({actor_name:profile?.full_name??"A student",actor_id:user.id,action:"joined a study pool",subject:pool.title,amount:pool.unit_price,emoji:"🛒",university:pool.university});
 await admin.from("notifications").insert({user_id:pool.organizer_id,type:"pool_joined",title:"👋 New Pool Member!",body:`${profile?.full_name??"Someone"} joined "${pool.title}". ${pool.max_capacity-pool.current_count} spots remaining.`,data:{pool_id:poolId,current_count:pool.current_count,max_capacity:pool.max_capacity}});
 return ok({success:true,current_count:pool.current_count,max_capacity:pool.max_capacity,spots_remaining:Math.max(0,pool.max_capacity-pool.current_count),pool_status:pool.current_count>=pool.max_capacity?"locked":"open"});
});
