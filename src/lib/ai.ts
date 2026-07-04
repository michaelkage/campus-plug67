import { supabase } from './supabase';

export async function analyzeChatContent(message: string): Promise<{ flags: any[]; hasCritical: boolean; primaryMessage: string | null }> {
  try {
    const { data, error } = await supabase.functions.invoke('ai-proxy', {
      body: { message }
    });
    
    if (error) {
      console.error('AI Proxy Error:', error);
      return { flags: [], hasCritical: false, primaryMessage: null };
    }
    
    return data;
  } catch (err) {
    console.error('Failed to analyze chat content', err);
    return { flags: [], hasCritical: false, primaryMessage: null };
  }
}
