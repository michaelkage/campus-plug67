import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { createHmac } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const response=(body:unknown,status=200)=>new Response(typeof body==="string"?body:JSON.stringify(body),{status,headers:CORS});
const admin=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false}});

serve(async(req:Request)=>{
  if(req.method!=="POST")return response("Method not allowed",405);
  const body=await req.text();
  const signature=req.headers.get("x-paystack-signature")??"";
  const secret=Deno.env.get("PAYSTACK_SECRET_KEY")??"";
  if(!secret)return response("Server misconfiguration",500);
  const expected=createHmac("sha512",secret).update(body).digest("hex");
  if(expected!==signature)return response("Invalid signature",400);
  let event:Record<string,any>;try{event=JSON.parse(body);}catch{return response("Invalid JSON payload",400);}
  if(event.event!=="charge.success")return response("OK",200);

  const reference=event.data?.reference;
  const amount=Number(event.data?.amount);
  const metadata=event.data?.metadata??{};
  if(typeof reference!=="string"||!Number.isSafeInteger(amount)||amount<=0)return response("Invalid payment payload",400);

  if(metadata.type!=="marketplace_escrow"){
    // PlugCredit top-ups are intentionally disabled until the client creates a
    // server-issued top-up intent. Do not trust arbitrary metadata.user_id to
    // decide who receives real-money credit.
    if(metadata.type==="plugcredit_topup")return response("Top-up requires a server-issued wallet intent",409);
    return response("OK",200);
  }

  const transactionId=typeof metadata.transaction_id==="string"?metadata.transaction_id:null;
  if(!transactionId)return response("Payment missing transaction_id",400);
  const {data,error}=await admin.rpc("process_paystack_success",{
    p_webhook_id:reference,
    p_event_type:event.event,
    p_reference:reference,
    p_amount:amount,
    p_transaction_id:transactionId,
  });
  if(error){console.error("Paystack processing failed",error.message);return response({error:error.message},400);}
  return response(data??{success:true},200);
});
