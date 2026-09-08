import { supabase } from './supabase'

export interface ChatScanFlag {
  id: string
  label: string
  severity: 'warning' | 'critical'
  message: string
  match?: string
}

export interface ChatScanResult {
  flags: ChatScanFlag[]
  hasCritical: boolean
  primaryMessage: string | null
}

function isChatScanFlag(value: unknown): value is ChatScanFlag {
  if (!value || typeof value !== 'object') return false
  const flag = value as Record<string, unknown>
  return (
    typeof flag.id === 'string' &&
    typeof flag.label === 'string' &&
    (flag.severity === 'warning' || flag.severity === 'critical') &&
    typeof flag.message === 'string' &&
    (flag.match === undefined || typeof flag.match === 'string')
  )
}

function normalizeChatScanResult(value: unknown): ChatScanResult {
  if (!value || typeof value !== 'object') {
    return { flags: [], hasCritical: false, primaryMessage: null }
  }

  const result = value as Record<string, unknown>
  const flags = Array.isArray(result.flags) ? result.flags.filter(isChatScanFlag) : []
  const hasCritical = flags.some((flag) => flag.severity === 'critical')
  const primary = flags.find((flag) => flag.severity === 'critical') ?? flags[0]

  return {
    flags,
    hasCritical,
    primaryMessage: primary?.message ?? (typeof result.primaryMessage === 'string' ? result.primaryMessage : null),
  }
}

export async function analyzeChatContent(message: string): Promise<ChatScanResult> {
  try {
    const { data, error } = await supabase.functions.invoke('ai-proxy', {
      body: { message },
    })

    if (error) {
      console.error('AI Proxy Error:', error)
      return { flags: [], hasCritical: false, primaryMessage: null }
    }

    return normalizeChatScanResult(data)
  } catch (err) {
    console.error('Failed to analyze chat content', err)
    return { flags: [], hasCritical: false, primaryMessage: null }
  }
}
