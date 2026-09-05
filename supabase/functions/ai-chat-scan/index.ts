import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { getAuthenticatedUser } from "../_shared/auth.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const ok=(d:unknown)=>new Response(JSON.stringify(d),{status:200,headers:CORS});
const bad=(m:string,s=400)=>new Response(JSON.stringify({error:m}),{status:s,headers:CORS});
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

const PAYMENT_PATTERNS=[/bank\s*transfer/i,/account\s*number/i,/sort\s*code/i,/send\s*money/i,/wire\s*transfer/i,/western\s*union/i,/moneygram/i,/070\d{8}|080\d{8}|081\d{8}|090\d{8}/,/\b\d{10,12}\b/,/pay\s*directly/i,/outside\s*campus\s*plug/i,/off\s*platform/i,/avoid\s*fees/i,/cash\s*payment/i,/bank\s*deposit/i,/transfer\s*to/i];
const CONTENT_MODERATION_PATTERNS=[/\b(nude|naked|sex|porn|xxx|adult)\b/i,/\b(drugs|weed|cocaine|heroin)\b/i,/\b(weapon|gun|knife|bomb)\b/i,/\b(scam|fraud|rip\s*off)\b/i,/\b(kill|murder|death|die)\b/i];

async function sha256(text:string){const bytes=new TextEncoder().encode(text);const hash=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");}

serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  if(req.method!=="POST") return bad("Method not allowed",405);
  const user=await getAuthenticatedUser(req);
  if(!user) return bad("Unauthorized",401);
  let body:Record<string,any>;
  try{body=await req.json();}catch{return bad("Invalid JSON");}
  const {message_id}=body;
  if(!message_id) return bad("Missing message_id");

  // Never trust sender/receiver/content supplied by the client. Read the message
  // from the database and authorize the caller against the actual participants.
  const {data:message,error:messageErr}=await admin.from("messages").select("id,sender_id,receiver_id,listing_id,body,content").eq("id",message_id).maybeSingle();
  if(messageErr) return bad(messageErr.message,500);
  if(!message) return bad("Message not found",404);
  if(message.sender_id!==user.id && message.receiver_id!==user.id) return bad("Not authorized for this message",403);

  const content=String(message.body ?? message.content ?? "");
  if(!content) return bad("Message has no text content");
  const chatType=typeof body.chat_type==="string"?body.chat_type:null;
  let flagged=false;let flag_type:string|null=null;let confidence=0;const matched_patterns:string[]=[];
  for(const pattern of PAYMENT_PATTERNS){if(pattern.test(content)){flagged=true;flag_type="payment_diversion";confidence=Math.max(confidence,.8);matched_patterns.push(pattern.toString());}}
  for(const pattern of CONTENT_MODERATION_PATTERNS){if(pattern.test(content)){flagged=true;flag_type=flag_type||"inappropriate_content";confidence=Math.max(confidence,.7);matched_patterns.push(pattern.toString());}}

  const contentHash=await sha256(content);
  const {error:scanErr}=await admin.from("chat_scan_logs").insert({message_id:message.id,sender_id:message.sender_id,receiver_id:message.receiver_id,chat_type:chatType,flagged,flag_type,confidence,matched_patterns:matched_patterns.join(", "),content_hash:contentHash});
  if(scanErr) console.error("chat scan log failed",scanErr.message);

  if(flagged){
    const {error:flagErr}=await admin.from("chat_flag_log").insert({sender_id:message.sender_id,listing_id:message.listing_id??null,message_hash:contentHash,flag_type:flag_type!,severity:confidence>=.8?"critical":"warning",action_taken:confidence>=.8?"blocked":"warned"});
    if(flagErr) console.error("chat flag log failed",flagErr.message);
    await admin.from("messages").update({flagged:true,flag_type}).eq("id",message.id);
  }

  return ok({success:true,flagged,flag_type,confidence,message:flagged?"Message flagged for review":"Message passed safety check"});
});
