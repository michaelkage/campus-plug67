import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { GoogleGenAI } from "npm:@google/genai";
import { getAuthenticatedUser, getBearerToken, jsonResponse, optionsResponse } from "../_shared/auth.ts";
import { enforceRateLimitWithToken } from "../_shared/rateLimit.ts";

const SAFE_FALLBACK = { hasCritical: false, primaryMessage: null, flags: [] };

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, {}, req);
  const user = await getAuthenticatedUser(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);
  const token = getBearerToken(req);
  if (!token) return jsonResponse({ error: "Unauthorized" }, 401, {}, req);

  try {
    const limit = await enforceRateLimitWithToken(token, "ai-proxy", 30, 60);
    if (!limit.allowed) return jsonResponse({ error: "Rate limit exceeded", reset_at: limit.resetAt }, 429, {}, req);
    const body: unknown = await req.json().catch(() => null);
    const message = typeof body === "object" && body !== null && "message" in body ? body.message : null;
    if (typeof message !== "string" || !message.trim()) return jsonResponse({ error: "Message is required" }, 400, {}, req);
    if (message.length > 5000) return jsonResponse({ error: "Message is too long" }, 400, {}, req);
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) return jsonResponse({ error: "AI service is not configured" }, 500, {}, req);

    const ai = new GoogleGenAI({ apiKey });
    const prompt = `You are a security scanner for a university marketplace app. Analyze the following chat message and determine if the user is trying to: 1. Request payment outside the platform (critical). 2. Share personal phone numbers or move chat to WhatsApp/Snapchat (warning). 3. Share student ID/matric numbers (warning). Respond ONLY as JSON with hasCritical, primaryMessage, and flags. Message: ${JSON.stringify(message)}`;
    const result = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt });
    const text = result.text?.trim();
    if (!text) return jsonResponse(SAFE_FALLBACK, 200, {}, req);
    const jsonStr = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();

    try {
      return jsonResponse(JSON.parse(jsonStr), 200, {}, req);
    } catch (parseError) {
      console.warn("[ai-proxy] Gemini returned malformed JSON", { parseError, raw: text });
      return jsonResponse(SAFE_FALLBACK, 200, {}, req);
    }
  } catch (error) {
    console.error("[ai-proxy] request failed", error);
    return jsonResponse({ error: error instanceof Error ? error.message : "AI scan failed" }, 500, {}, req);
  }
});
