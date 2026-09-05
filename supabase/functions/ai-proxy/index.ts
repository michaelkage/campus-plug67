import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { GoogleGenAI } from "npm:@google/genai";
import { getAuthenticatedUser, getBearerToken } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const CORS={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Content-Type":"application/json"};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:CORS});

serve(async(req:Request)=>{
  if(req.method==="OPTIONS") return new Response("ok",{headers:CORS});
  if(req.method!=="POST") return response({error:"Method not allowed"},405);
  const user=await getAuthenticatedUser(req);
  if(!user) return response({error:"Unauthorized"},401);
  const token=getBearerToken(req);
  if(!token) return response({error:"Unauthorized"},401);
  try{
    const limit=await enforceRateLimitWithToken(token,"ai-proxy",30,60);
    if(!limit.allowed) return response({error:"Rate limit exceeded",reset_at:limit.resetAt},429);
    const {message}=await req.json();
    if(typeof message!=="string"||!message.trim()) return response({error:"Message is required"},400);
    if(message.length>5000) return response({error:"Message is too long"},400);
    const apiKey=Deno.env.get("GEMINI_API_KEY");
    if(!apiKey) return response({error:"AI service is not configured"},500);
    const ai=new GoogleGenAI({apiKey});
    const prompt=`You are a security scanner for a university marketplace app. Analyze the following chat message and determine if the user is trying to: 1. Request payment outside the platform (critical). 2. Share personal phone numbers or move chat to WhatsApp/Snapchat (warning). 3. Share student ID/matric numbers (warning). Respond ONLY as JSON with hasCritical, primaryMessage, and flags. Message: ${JSON.stringify(message)}`;
    const result=await ai.models.generateContent({model:"gemini-2.5-flash",contents:prompt});
    const text=result.text?.trim();
    if(!text) return response({hasCritical:false,primaryMessage:null,flags:[]});
    const jsonStr=text.replace(/^```json\s*/i,"").replace(/\s*```$/i,"").trim();
    return response(JSON.parse(jsonStr));
  }catch(error){return response({error:error instanceof Error?error.message:"AI scan failed"},500);}
});
