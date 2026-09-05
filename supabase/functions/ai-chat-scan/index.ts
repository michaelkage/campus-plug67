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
  try{body=await req.json();}catch{return bad("Invalid JSON payload",400);}

  const {message_id,raw_content,receiver_id,chat_type}=body;
  let contentToScan="";
  let senderId=user.id;
  let targetReceiverId=receiver_id;
  let listingId:string|null=null;
  let persistedMessageId:string|null=null;

  if(message_id && typeof message_id==="string" && !message_id.startsWith("temp-")){
    // Post-commit mode: Load authoritative record from database
    const {data:message,error:messageErr}=await admin.from("messages").select("id,sender_id,receiver_id,listing_id,body,content").eq("id",message_id).maybeSingle();
    if(messageErr) return bad(messageErr.message,500);
    if(!message) return bad("Message not found",404);
    if(message.sender_id!==user.id && message.receiver_id!==user.id){
      return bad("Not authorized to scan this message",403);
    }
    contentToScan=String(message.body ?? message.content ?? "");
    senderId=message.sender_id;
    targetReceiverId=message.receiver_id;
    listingId=message.listing_id??null;
    persistedMessageId=message.id;
  } else if(typeof raw_content==="string" && raw_content.trim().length>0){
    // Pre-flight validation mode: Scan text directly before client DB insertion
    contentToScan=raw_content.trim();
  } else {
    return bad("Provide either a valid persisted message_id or raw_content to scan",400);
  }

  if(!contentToScan) return bad("Message has no text content");
  const parsedChatType=typeof chat_type==="string"?chat_type:null;
  let flagged=false;let flag_type:string|null=null;let confidence=0;const matched_patterns:string[]=[];
  for(const pattern of PAYMENT_PATTERNS){if(pattern.test(contentToScan)){flagged=true;flag_type="payment_diversion";confidence=Math.max(confidence,.8);matched_patterns.push(pattern.toString());}}
  for(const pattern of CONTENT_MODERATION_PATTERNS){if(pattern.test(contentToScan)){flagged=true;flag_type=flag_type||"inappropriate_content";confidence=Math.max(confidence,.7);matched_patterns.push(pattern.toString());}}

  const contentHash=await sha256(contentToScan);

  if(persistedMessageId){
    const {error:scanErr}=await admin.from("chat_scan_logs").insert({message_id:persistedMessageId,sender_id:senderId,receiver_id:targetReceiverId,chat_type:parsedChatType,flagged,flag_type,confidence,matched_patterns:matched_patterns.join(", "),content_hash:contentHash});
    if(scanErr) console.error("chat scan log failed",scanErr.message);

    if(flagged){
      const {error:flagErr}=await admin.from("chat_flag_log").insert({sender_id:senderId,listing_id:listingId,message_hash:contentHash,flag_type:flag_type!,severity:confidence>=.8?"critical":"warning",action_taken:confidence>=.8?"blocked":"warned"});
      if(flagErr) console.error("chat flag log failed",flagErr.message);
      await admin.from("messages").update({flagged:true,flag_type}).eq("id",persistedMessageId);
    }
  }

  return ok({success:true,flagged,flag_type,confidence,message:flagged?"Message flagged for review":"Message passed safety check"});
});
