import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { getAuthenticatedUser, jsonResponse, optionsResponse } from "../_shared/auth.ts";

const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});
const PAYMENT_PATTERNS=[/bank\s*transfer/i,/account\s*number/i,/sort\s*code/i,/send\s*money/i,/wire\s*transfer/i,/western\s*union/i,/moneygram/i,/070\d{8}|080\d{8}|081\d{8}|090\d{8}/,/\b\d{10,12}\b/,/pay\s*directly/i,/outside\s*campus\s*plug/i,/off\s*platform/i,/avoid\s*fees/i,/cash\s*payment/i,/bank\s*deposit/i,/transfer\s*to/i];
const CONTENT_MODERATION_PATTERNS=[/\b(nude|naked|sex|porn|xxx|adult)\b/i,/\b(drugs|weed|cocaine|heroin)\b/i,/\b(weapon|gun|knife|bomb)\b/i,/\b(scam|fraud|rip\s*off)\b/i,/\b(kill|murder|death|die)\b/i];

async function sha256(text:string){const bytes=new TextEncoder().encode(text);const hash=await crypto.subtle.digest("SHA-256",bytes);return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,"0")).join("");}

type ScanBody={message_id?:unknown;raw_content?:unknown;receiver_id?:unknown;chat_type?:unknown};

serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return optionsResponse(req);
  if(req.method!=="POST") return jsonResponse({error:"Method not allowed"},405,{},req);
  const user=await getAuthenticatedUser(req);
  if(!user)return jsonResponse({error:"Unauthorized"},401,{},req);
  const body:ScanBody=await req.json().catch(()=>({}));
  const messageId=typeof body.message_id==="string"?body.message_id:null;
  const rawContent=typeof body.raw_content==="string"?body.raw_content:null;
  const receiverId=typeof body.receiver_id==="string"?body.receiver_id:null;
  const chatType=typeof body.chat_type==="string"?body.chat_type:null;
  let contentToScan="";let senderId=user.id;let targetReceiverId=receiverId;let listingId:string|null=null;let persistedMessageId:string|null=null;

  if(messageId&&!messageId.startsWith("temp-")){
    const {data:message,error:messageErr}=await admin.from("messages").select("id,sender_id,receiver_id,listing_id,body,content").eq("id",messageId).maybeSingle();
    if(messageErr)return jsonResponse({error:messageErr.message},500,{},req);
    if(!message)return jsonResponse({error:"Message not found"},404,{},req);
    if(message.sender_id!==user.id&&message.receiver_id!==user.id)return jsonResponse({error:"Not authorized to scan this message"},403,{},req);
    contentToScan=String(message.body??message.content??"");senderId=message.sender_id;targetReceiverId=message.receiver_id;listingId=message.listing_id??null;persistedMessageId=message.id;
  }else if(rawContent?.trim()){
    contentToScan=rawContent.trim();
  }else return jsonResponse({error:"Provide either a valid persisted message_id or raw_content to scan"},400,{},req);

  if(!contentToScan)return jsonResponse({error:"Message has no text content"},400,{},req);
  let flagged=false;let flagType:string|null=null;let confidence=0;const matchedPatterns:string[]=[];
  for(const pattern of PAYMENT_PATTERNS)if(pattern.test(contentToScan)){flagged=true;flagType="payment_diversion";confidence=Math.max(confidence,.8);matchedPatterns.push(pattern.toString());}
  for(const pattern of CONTENT_MODERATION_PATTERNS)if(pattern.test(contentToScan)){flagged=true;flagType=flagType||"inappropriate_content";confidence=Math.max(confidence,.7);matchedPatterns.push(pattern.toString());}
  const contentHash=await sha256(contentToScan);

  if(persistedMessageId){
    const {error:scanErr}=await admin.from("chat_scan_logs").insert({message_id:persistedMessageId,sender_id:senderId,receiver_id:targetReceiverId,chat_type:chatType,flagged,flag_type:flagType,confidence,matched_patterns:matchedPatterns.join(", "),content_hash:contentHash});
    if(scanErr)console.error("chat scan log failed",scanErr.message);
    if(flagged){
      const {error:flagErr}=await admin.from("chat_flag_log").insert({sender_id:senderId,listing_id:listingId,message_hash:contentHash,flag_type:flagType!,severity:confidence>=.8?"critical":"warning",action_taken:confidence>=.8?"blocked":"warned"});
      if(flagErr)console.error("chat flag log failed",flagErr.message);
      await admin.from("messages").update({flagged:true,flag_type:flagType}).eq("id",persistedMessageId);
    }
  }
  return jsonResponse({success:true,flagged,flag_type:flagType,confidence,message:flagged?"Message flagged for review":"Message passed safety check"},200,{},req);
});
