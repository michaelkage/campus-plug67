import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { GoogleGenAI } from "npm:@google/genai";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      throw new Error('Missing Authorization header');
    }

    const { message } = await req.json();
    if (!message) {
      throw new Error('Message is required');
    }

    const apiKey = Deno.env.get('GEMINI_API_KEY');
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not set');
    }

    const ai = new GoogleGenAI({ apiKey });

    // System instruction to detect obfuscated payment requests and personal info sharing
    const prompt = `
      You are a security scanner for a university marketplace app.
      Analyze the following chat message and determine if the user is trying to:
      1. Request payment outside the platform (e.g. OPay, Kuda, direct transfer, "send to this account") - critical severity.
      2. Share personal phone numbers or move chat to WhatsApp/Snapchat - warning severity.
      3. Share student ID/matric numbers - warning severity.

      Respond ONLY in JSON format with this structure:
      {
        "hasCritical": boolean,
        "primaryMessage": string | null (a human readable warning if flagged),
        "flags": [
          { "id": "external_payment" | "phone_number" | "whatsapp" | "matric_sharing", "severity": "critical" | "warning", "message": "warning message" }
        ]
      }

      Message: "${message}"
    `;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });

    let result = { hasCritical: false, primaryMessage: null, flags: [] };
    const text = response.text;
    
    if (text) {
        // Strip markdown code blocks if present
        const jsonStr = text.replace(/```json\n?|\n?```/g, '').trim();
        result = JSON.parse(jsonStr);
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 400,
    });
  }
});
