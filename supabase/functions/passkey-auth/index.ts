import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser, jsonResponse, optionsResponse } from "../_shared/auth.ts";
import { enforceRateLimitByKey } from "../_shared/rateLimit.ts";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "https://esm.sh/@simplewebauthn/server@10.0.0";
import { encode as encodeBase64Url, decode as decodeBase64Url } from "https://deno.land/std@0.168.0/encoding/base64url.ts";

const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const RP_NAME="Campus Plug";const RP_ID=Deno.env.get("RP_ID")??"campusplug.ng";const ORIGIN=Deno.env.get("APP_ORIGIN")??"https://campusplug.ng";const CHALLENGE_TTL_MS=5*60*1000;
type ChallengeEntry={challenge:string;expiresAt:number};
type PasskeyBody={action?:string;userId?:string;userEmail?:string;response?:Record<string,unknown>;deviceLabel?:string;client_fingerprint?:string|null};
const cache=new Map<string,ChallengeEntry>();

function requestIp(req:Request){return req.headers.get("cf-connecting-ip")||req.headers.get("x-real-ip")||req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"unknown";}
async function sha256(value:string){const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(digest)).map((b)=>b.toString(16).padStart(2,"0")).join("");}

async function assertDeviceAllowed(req:Request,clientFingerprint:string|null){
  const ip=requestIp(req);
  const ua=(req.headers.get("user-agent")||"unknown").slice(0,512);
  const language=(req.headers.get("accept-language")||"").slice(0,128);
  const serverFingerprint=await sha256(`${ip}\n${ua}\n${language}`);
  const {data:banHit,error:banError}=await admin.rpc("check_device_ban",{
    p_server_fingerprint:serverFingerprint,
    p_ip:ip==="unknown"?null:ip,
    p_client_fingerprint:clientFingerprint,
  });
  if(banError){
    const {data:banned,error:bannedError}=await admin.from("banned_devices").select("ban_reason,reason").eq("server_fingerprint",serverFingerprint).eq("active",true).maybeSingle();
    if(bannedError)return {ok:false,error:"Security service unavailable"};
    if(banned)return {ok:false,error:`DEVICE_BANNED: ${banned.ban_reason||banned.reason||"This device has been restricted."}`};
  }else if(banHit?.banned){
    return {ok:false,error:`DEVICE_BANNED: ${banHit.reason||"This device has been restricted."}`};
  }
  return {ok:true};
}

async function rateLimitPasskey(req:Request,action:string,userId?:string){
  const ip=requestIp(req);
  const key=await sha256(`${ip}|${userId||"unknown"}`);
  return enforceRateLimitByKey(`passkey:${action}`,key,10,60);
}

async function saveChallenge(userId:string,type:"reg"|"auth",challenge:string){const key=`challenge:${userId}:${type}`;const expiresAtMs=Date.now()+CHALLENGE_TTL_MS;cache.set(key,{challenge,expiresAt:expiresAtMs});const {error}=await admin.from("auth_challenges").upsert({user_id:userId,challenge_type:type,challenge,expires_at:new Date(expiresAtMs).toISOString()},{onConflict:"user_id,challenge_type"});if(error) await admin.from("user_security").upsert({user_id:userId,device_hash:key,device_label:`__challenge__${challenge}`,flag_type:"webauthn_challenge",created_at:new Date().toISOString()},{onConflict:"user_id,device_hash"});}
async function loadChallenge(userId:string,type:"reg"|"auth"){const key=`challenge:${userId}:${type}`;const cached=cache.get(key);if(cached){if(Date.now()>cached.expiresAt){await clearChallenge(userId,type);return null;}return cached.challenge;}const {data:row}=await admin.from("auth_challenges").select("challenge,expires_at").eq("user_id",userId).eq("challenge_type",type).maybeSingle();if(row?.challenge){if(new Date(row.expires_at).getTime()<Date.now()){await clearChallenge(userId,type);return null;}cache.set(key,{challenge:row.challenge,expiresAt:new Date(row.expires_at).getTime()});return row.challenge;}return null;}
async function clearChallenge(userId:string,type:"reg"|"auth"){const key=`challenge:${userId}:${type}`;cache.delete(key);await admin.from("auth_challenges").delete().eq("user_id",userId).eq("challenge_type",type);await admin.from("user_security").delete().eq("user_id",userId).eq("device_hash",key);}

serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return optionsResponse(req);
  if(req.method==="GET"&&new URL(req.url).pathname.endsWith("/ping"))return jsonResponse({status:"warm",ts:Date.now(),fn:"passkey-auth"},200,{},req);
  if(req.method!=="POST")return jsonResponse({error:"Method not allowed"},405,{},req);
  let body:PasskeyBody;try{body=await req.json();}catch{return jsonResponse({error:"Invalid JSON"},400,{},req);}
  const {action,userId,userEmail,response,deviceLabel}=body;
  const clientFingerprint=typeof body.client_fingerprint==="string"?body.client_fingerprint.slice(0,512):null;

  if(action==="generate_registration_options"||action==="verify_registration"){const user=await getAuthenticatedUser(req);if(!user)return jsonResponse({error:"Unauthorized"},401,{},req);if(userId!==user.id)return jsonResponse({error:"User identity mismatch"},403,{},req);}

  if(action==="generate_registration_options"){
    if(!userId||!userEmail)return jsonResponse({error:"Missing userId or userEmail"},400,{},req);
    const rate=await rateLimitPasskey(req,action,userId);if(!rate.allowed)return jsonResponse({error:"Too many passkey requests. Please wait and try again."},429,{"Retry-After":"60"},req);
    const {data:existing}=await admin.from("passkey_credentials").select("credential_id,transports").eq("user_id",userId);
    const options=await generateRegistrationOptions({rpName:RP_NAME,rpID:RP_ID,userID:new TextEncoder().encode(userId),userName:userEmail,timeout:60000,attestationType:"none",excludeCredentials:(existing??[]).map(c=>({id:c.credential_id,type:"public-key",transports:c.transports??["internal","hybrid"]})),authenticatorSelection:{residentKey:"required",userVerification:"required"}});
    await saveChallenge(userId,"reg",options.challenge);return jsonResponse({options},200,{},req);
  }

  if(action==="verify_registration"){
    if(!userId||!response)return jsonResponse({error:"Missing userId or response"},400,{},req);const expectedChallenge=await loadChallenge(userId,"reg");if(!expectedChallenge)return jsonResponse({error:"Challenge expired or not found. Please retry."},400,{},req);
    let verification;try{verification=await verifyRegistrationResponse({response:response as never,expectedChallenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,requireUserVerification:true});}catch(e){return jsonResponse({error:"Verification failed: "+(e as Error).message},400,{},req);}
    if(!verification.verified||!verification.registrationInfo)return jsonResponse({error:"Passkey verification did not succeed"},400,{},req);
    const {credentialID,credentialPublicKey,counter,credentialBackedUp}=verification.registrationInfo;
    const responseTransports=Array.isArray((response as Record<string,unknown>).response && ((response as Record<string,unknown>).response as Record<string,unknown>).transports)?((response as Record<string,unknown>).response as Record<string,unknown>).transports as string[]:[];
    const transports=[...new Set(responseTransports.length?responseTransports:["internal","hybrid"])];
    const {error}=await admin.from("passkey_credentials").insert({user_id:userId,credential_id:credentialID,public_key:encodeBase64Url(credentialPublicKey),sign_count:counter,transports,device_label:deviceLabel||"My Passkey",backed_up:credentialBackedUp});
    if(error)return jsonResponse({error:"Failed to save credential: "+error.message},400,{},req);await clearChallenge(userId,"reg");return jsonResponse({verified:true,credentialID,transports},200,{},req);
  }

  if(action==="generate_authentication_options"){
    if(!userId)return jsonResponse({error:"Missing userId"},400,{},req);
    const rate=await rateLimitPasskey(req,action,userId);if(!rate.allowed)return jsonResponse({error:"Too many passkey requests. Please wait and try again."},429,{"Retry-After":"60"},req);
    const deviceCheck=await assertDeviceAllowed(req,clientFingerprint);if(!deviceCheck.ok)return jsonResponse({error:deviceCheck.error},deviceCheck.error?.startsWith("DEVICE_BANNED")?403:503,{},req);
    const {data:creds}=await admin.from("passkey_credentials").select("credential_id,transports").eq("user_id",userId);if(!creds?.length)return jsonResponse({options:null},200,{},req);
    const options=await generateAuthenticationOptions({rpID:RP_ID,timeout:60000,allowCredentials:creds.map(c=>({id:c.credential_id,type:"public-key",transports:(c.transports?.length?c.transports:["internal","hybrid"]) as never})),userVerification:"required"});await saveChallenge(userId,"auth",options.challenge);return jsonResponse({options},200,{},req);
  }

  if(action==="verify_authentication"){
    if(!userId||!response)return jsonResponse({error:"Missing userId or response"},400,{},req);
    const rate=await rateLimitPasskey(req,action,userId);if(!rate.allowed)return jsonResponse({error:"Too many passkey requests. Please wait and try again."},429,{"Retry-After":"60"},req);
    const deviceCheck=await assertDeviceAllowed(req,clientFingerprint);if(!deviceCheck.ok)return jsonResponse({error:deviceCheck.error},deviceCheck.error?.startsWith("DEVICE_BANNED")?403:503,{},req);
    const credId=typeof response.id==="string"?response.id:"";const {data:cred}=await admin.from("passkey_credentials").select("*").eq("credential_id",credId).eq("user_id",userId).maybeSingle();if(!cred)return jsonResponse({error:"Credential not found"},400,{},req);const expectedChallenge=await loadChallenge(userId,"auth");if(!expectedChallenge)return jsonResponse({error:"Challenge expired. Please retry login."},400,{},req);
    let verification;try{verification=await verifyAuthenticationResponse({response:response as never,expectedChallenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,authenticator:{credentialID:cred.credential_id,credentialPublicKey:decodeBase64Url(cred.public_key),counter:cred.sign_count??0,transports:(cred.transports?.length?cred.transports:["internal","hybrid"]) as never},requireUserVerification:true});}catch(e){return jsonResponse({error:"Auth verification failed: "+(e as Error).message},400,{},req);}
    if(!verification.verified)return jsonResponse({error:"Signature invalid"},400,{},req);await admin.from("passkey_credentials").update({sign_count:verification.authenticationInfo.newCounter,last_used_at:new Date().toISOString()}).eq("credential_id",credId);await clearChallenge(userId,"auth");const {data:profileData}=await admin.from("profiles").select("email").eq("id",userId).single();const {data:sessionData,error:sessionErr}=await admin.auth.admin.generateLink({type:"magiclink",email:profileData?.email??""});if(sessionErr||!sessionData)return jsonResponse({error:"Session generation failed"},400,{},req);const {data:session}=await admin.auth.verifyOtp({token_hash:sessionData.properties?.hashed_token??"",type:"magiclink"});return jsonResponse({verified:true,access_token:session?.session?.access_token??null,refresh_token:session?.session?.refresh_token??null},200,{},req);
  }
  return jsonResponse({error:`Unknown action: ${action}`},400,{},req);
});
