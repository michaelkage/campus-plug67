import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, getBearerToken } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const ok=(d:unknown)=>new Response(JSON.stringify(d),{status:200,headers:CORS});
const bad=(m:string,s=400)=>new Response(JSON.stringify({error:m}),{status:s,headers:CORS});
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

async function sha256(value:string){
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

function requestIp(req:Request){
  return req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** /24 for IPv4, /48 for IPv6 — used when writing bans so rotation within a subnet still matches. */
function ipPrefixCidr(ip:string):string|null{
  if(!ip||ip==="unknown") return null;
  if(ip.includes(".")){
    const parts=ip.split(".");
    if(parts.length!==4||parts.some(p=>Number.isNaN(Number(p)))) return null;
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if(ip.includes(":")){
    const expanded=ip.split("::");
    // Keep first three hextets when possible for a coarse /48-style prefix string.
    const head=(expanded[0]||"").split(":").filter(Boolean).slice(0,3);
    if(head.length===0) return null;
    while(head.length<3) head.push("0");
    return `${head.join(":")}::/48`;
  }
  return null;
}

serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  if(req.method!=="POST") return bad("Method not allowed",405);
  let body:Record<string,unknown>;
  try{body=await req.json();}catch{return bad("Invalid JSON");}
  const action=String(body.action??"check");
  if(action!=="check" && action!=="register") return bad("Invalid action");

  const token=getBearerToken(req);
  if(token){
    try{const limit=await enforceRateLimitWithToken(token,"security-gate",20,60);if(!limit.allowed)return bad("Rate limit exceeded",429);}catch{return bad("Rate limit service unavailable",503);}
  }

  const user=await getAuthenticatedUser(req);
  if(action==="register" && !user) return bad("Unauthorized",401);

  // These values are observed by the server. They are not accepted from the
  // browser body and therefore cannot be replaced by a forged fingerprint payload.
  const ip=requestIp(req);
  const ua=(req.headers.get("user-agent")||"unknown").slice(0,512);
  const language=(req.headers.get("accept-language")||"").slice(0,128);
  const serverFingerprint=await sha256(`${ip}\n${ua}\n${language}`);
  const clientFingerprint=typeof body.client_fingerprint==="string"?body.client_fingerprint.slice(0,128):null;

  // Match exact server hash, subnet prefix, or known client correlation id.
  const {data:banHit,error:banError}=await admin.rpc("check_device_ban",{
    p_server_fingerprint:serverFingerprint,
    p_ip:ip==="unknown"?null:ip,
    p_client_fingerprint:clientFingerprint,
  });
  if(banError){
    // Fallback if migration not applied yet: exact fingerprint only.
    const {data:banned,error:bannedError}=await admin.from("banned_devices")
      .select("ban_reason,reason")
      .eq("server_fingerprint",serverFingerprint)
      .eq("active",true)
      .maybeSingle();
    if(bannedError) return bad("Security service unavailable",503);
    if(banned) return bad(`DEVICE_BANNED: ${banned.ban_reason||banned.reason||"This device has been restricted."}`,403);
  } else if(banHit?.banned){
    return bad(`DEVICE_BANNED: ${banHit.reason||"This device has been restricted."}`,403);
  }

  if(user){
    const deviceHash=clientFingerprint||serverFingerprint;
    const {error}=await admin.from("user_security").upsert({
      user_id:user.id,
      device_hash:deviceHash,
      server_fingerprint:serverFingerprint,
      ip_address:ip,
      user_agent:ua,
      trusted:false,
      risk_score:0,
      last_seen_at:new Date().toISOString(),
      last_risk_check_at:new Date().toISOString()
    },{onConflict:"user_id,device_hash"});
    if(error) return bad("Unable to register security context",503);
  }

  return ok({
    success:true,
    server_fingerprint:action==="register"?serverFingerprint:undefined,
    ip_prefix_hint:action==="register"?ipPrefixCidr(ip):undefined,
  });
});
