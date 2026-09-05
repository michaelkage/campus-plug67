import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser,getBearerToken } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";
const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const ok=(d:unknown)=>new Response(JSON.stringify(d),{status:200,headers:CORS});
const bad=(m:string,s=400)=>new Response(JSON.stringify({error:m}),{status:s,headers:CORS});
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
serve(async(req:Request)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
 if(req.method==="GET"&&new URL(req.url).pathname.endsWith("/ping"))return ok({status:"warm",ts:Date.now(),fn:"join-pool"});
 if(req.method!=="POST")return bad("Method not allowed",405);
 const user=await getAuthenticatedUser(req);if(!user)return bad("Unauthorized",401);
 const token=getBearerToken(req);if(!token)return bad("Unauthorized",401);
 try{const limit=await enforceRateLimitWithToken(token,"study-pool-joins",20,60);if(!limit.allowed)return bad("Rate limit exceeded",429);}catch{return bad("Rate limit service unavailable",503);}
 let body:Record<string,any>;try{body=await req.json();}catch{return bad("Invalid JSON");}
 const poolId=typeof body.pool_id==="string"?body.pool_id:"";const paystackRef=typeof body.paystack_ref==="string"?body.paystack_ref:null;if(!poolId)return bad("Missing pool_id");
 const {data,error:resultError}=await admin.rpc("atomic_pool_join",{p_pool_id:poolId,p_user_id:user.id,p_ref:paystackRef});
 if(resultError)return bad(resultError.message,500);if(!data?.success){const status=data?.reason==="pool_not_found"?404:400;return bad(data?.reason??"Unable to join pool",status);}
 const pool=data.pool;const {data:profile}=await admin.from("profiles").select("full_name").eq("id",user.id).single();
 await admin.from("activity_feed").insert({actor_name:profile?.full_name??"A student",actor_id:user.id,action:"joined a study pool",subject:pool.title,amount:pool.unit_price,emoji:"🛒",university:pool.university});
 await admin.from("notifications").insert({user_id:pool.organizer_id,type:"pool_joined",title:"👋 New Pool Member!",body:`${profile?.full_name??"Someone"} joined "${pool.title}". ${pool.max_capacity-pool.current_count} spots remaining.`,data:{pool_id:poolId,current_count:pool.current_count,max_capacity:pool.max_capacity}});
 return ok({success:true,current_count:pool.current_count,max_capacity:pool.max_capacity,spots_remaining:Math.max(0,pool.max_capacity-pool.current_count),pool_status:pool.current_count>=pool.max_capacity?"locked":"open"});
});
