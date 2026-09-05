import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { getAuthenticatedUser } from "../_shared/auth.ts";
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from "https://esm.sh/@simplewebauthn/server@10.0.0";
import { encode as encodeBase64Url, decode as decodeBase64Url } from "https://deno.land/std@0.168.0/encoding/base64url.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const ok=(d:unknown)=>new Response(JSON.stringify(d),{status:200,headers:CORS});
const bad=(m:string,s=400)=>new Response(JSON.stringify({error:m}),{status:s,headers:CORS});
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const RP_NAME="Campus Plug";const RP_ID=Deno.env.get("RP_ID")??"campusplug.ng";const ORIGIN=Deno.env.get("APP_ORIGIN")??"https://campusplug.ng";const CHALLENGE_TTL_MS=5*60*1000;

type ChallengeEntry={challenge:string;expiresAt:number};
const cache=new Map<string,ChallengeEntry>();

async function saveChallenge(userId:string,type:"reg"|"auth",challenge:string){
  const key=`challenge:${userId}:${type}`;
  const expiresAtMs=Date.now()+CHALLENGE_TTL_MS;
  cache.set(key,{challenge,expiresAt:expiresAtMs});
  const expiresAtIso=new Date(expiresAtMs).toISOString();

  const {error}=await admin.from("auth_challenges").upsert({
    user_id:userId,
    challenge_type:type,
    challenge,
    expires_at:expiresAtIso,
  },{onConflict:"user_id,challenge_type"});

  if(error){
    // Backward-compatibility fallback if migration 036 not yet migrated
    await admin.from("user_security").upsert({
      user_id:userId,
      device_hash:key,
      device_label:`__challenge__${challenge}`,
      flag_type:"webauthn_challenge",
      created_at:new Date().toISOString(),
    },{onConflict:"user_id,device_hash"}).catch(()=>{});
  }
}

async function loadChallenge(userId:string,type:"reg"|"auth"){
  const key=`challenge:${userId}:${type}`;
  const cached=cache.get(key);
  if(cached){
    if(Date.now()>cached.expiresAt){await clearChallenge(userId,type);return null;}
    return cached.challenge;
  }

  const {data:challengeRow}=await admin.from("auth_challenges")
    .select("challenge,expires_at")
    .eq("user_id",userId)
    .eq("challenge_type",type)
    .maybeSingle();

  if(challengeRow?.challenge){
    if(new Date(challengeRow.expires_at).getTime()<Date.now()){
      await clearChallenge(userId,type);
      return null;
    }
    cache.set(key,{challenge:challengeRow.challenge,expiresAt:new Date(challengeRow.expires_at).getTime()});
    return challengeRow.challenge;
  }

  // Fallback to legacy user_security lookup
  const {data}=await admin.from("user_security").select("device_label,created_at").eq("user_id",userId).eq("device_hash",key).maybeSingle();
  if(!data?.device_label)return null;
  if(Date.now()-new Date(data.created_at).getTime()>CHALLENGE_TTL_MS){await clearChallenge(userId,type);return null;}
  const challenge=data.device_label.replace("__challenge__","");
  cache.set(key,{challenge,expiresAt:new Date(data.created_at).getTime()+CHALLENGE_TTL_MS});
  return challenge;
}

async function clearChallenge(userId:string,type:"reg"|"auth"){
  const key=`challenge:${userId}:${type}`;
  cache.delete(key);
  await admin.from("auth_challenges").delete().eq("user_id",userId).eq("challenge_type",type);
  await admin.from("user_security").delete().eq("user_id",userId).eq("device_hash",key).catch(()=>{});
}

serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:CORS});
  if(req.method==="GET"&&new URL(req.url).pathname.endsWith("/ping"))return ok({status:"warm",ts:Date.now(),fn:"passkey-auth"});
  let body:Record<string,any>;try{body=await req.json();}catch{return bad("Invalid JSON");}
  const {action,userId,userEmail,response,deviceLabel}=body;

  // Registration changes an authenticated account and therefore must be bound
  // to the JWT subject. Login remains intentionally unauthenticated because the
  // passkey itself is the credential being verified.
  if(action==="generate_registration_options"||action==="verify_registration"){
    const user=await getAuthenticatedUser(req);if(!user)return bad("Unauthorized",401);
    if(userId!==user.id)return bad("User identity mismatch",403);
  }

  if(action==="generate_registration_options"){
    if(!userId||!userEmail)return bad("Missing userId or userEmail");
    const {data:existing}=await admin.from("passkey_credentials").select("credential_id,transports").eq("user_id",userId);
    const options=await generateRegistrationOptions({rpName:RP_NAME,rpID:RP_ID,userID:userId,userName:userEmail,timeout:60000,attestationType:"none",excludeCredentials:(existing??[]).map(c=>({id:c.credential_id,type:"public-key",transports:c.transports??[]})),authenticatorSelection:{residentKey:"required",userVerification:"required",authenticatorAttachment:"platform"}});
    await saveChallenge(userId,"reg",options.challenge);return ok({options});
  }

  if(action==="verify_registration"){
    if(!userId||!response)return bad("Missing userId or response");
    const expectedChallenge=await loadChallenge(userId,"reg");if(!expectedChallenge)return bad("Challenge expired or not found. Please retry.");
    let verification;try{verification=await verifyRegistrationResponse({response:response as never,expectedChallenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,requireUserVerification:true});}catch(e){return bad("Verification failed: "+(e as Error).message);}
    if(!verification.verified||!verification.registrationInfo)return bad("Passkey verification did not succeed");
    const {credentialID,credentialPublicKey,counter,credentialBackedUp}=verification.registrationInfo;
    const {error}=await admin.from("passkey_credentials").insert({user_id:userId,credential_id:credentialID,public_key:encodeBase64Url(credentialPublicKey),sign_count:counter,transports:[],device_label:deviceLabel||"My Passkey",backed_up:credentialBackedUp});
    if(error)return bad("Failed to save credential: "+error.message);await clearChallenge(userId,"reg");return ok({verified:true,credentialID});
  }

  if(action==="generate_authentication_options"){
    if(!userId)return bad("Missing userId");
    const {data:creds}=await admin.from("passkey_credentials").select("credential_id,transports").eq("user_id",userId);
    if(!creds?.length)return ok({options:null});
    const options=await generateAuthenticationOptions({rpID:RP_ID,timeout:60000,allowCredentials:creds.map(c=>({id:c.credential_id,type:"public-key",transports:c.transports??["internal"]})),userVerification:"required"});
    await saveChallenge(userId,"auth",options.challenge);return ok({options});
  }

  if(action==="verify_authentication"){
    if(!userId||!response)return bad("Missing userId or response");
    const credId=(response as Record<string,string>).id;
    const {data:cred}=await admin.from("passkey_credentials").select("*").eq("credential_id",credId).eq("user_id",userId).maybeSingle();
    if(!cred)return bad("Credential not found");
    const expectedChallenge=await loadChallenge(userId,"auth");if(!expectedChallenge)return bad("Challenge expired. Please retry login.");
    let verification;try{verification=await verifyAuthenticationResponse({response:response as never,expectedChallenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,authenticator:{credentialID:cred.credential_id,credentialPublicKey:decodeBase64Url(cred.public_key),counter:cred.sign_count??0,transports:cred.transports??[]},requireUserVerification:true});}catch(e){return bad("Auth verification failed: "+(e as Error).message);}
    if(!verification.verified)return bad("Signature invalid");
    await admin.from("passkey_credentials").update({sign_count:verification.authenticationInfo.newCounter,last_used_at:new Date().toISOString()}).eq("credential_id",credId);
    await clearChallenge(userId,"auth");
    const {data:profileData}=await admin.from("profiles").select("email").eq("id",userId).single();
    const {data:sessionData,error:sessionErr}=await admin.auth.admin.generateLink({type:"magiclink",email:profileData?.email??""});
    if(sessionErr||!sessionData)return bad("Session generation failed");
    const {data:session}=await admin.auth.verifyOtp({token_hash:sessionData.properties?.hashed_token??"",type:"magiclink"});
    return ok({verified:true,access_token:session?.session?.access_token??null,refresh_token:session?.session?.refresh_token??null});
  }
  return bad(`Unknown action: ${action}`);
});
