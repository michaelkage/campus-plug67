import { supabase } from '@/lib/supabase/client'

/**
 * Record a user-visible security/audit event through the database's
 * SECURITY DEFINER writer. The caller can never choose the audit user_id.
 */
export async function writeSecurityAudit(
  entityType: string,
  entityId: string,
  action: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase.rpc('write_security_audit', {
    p_entity_type: entityType,
    p_entity_id: entityId,
    p_action: action,
    p_metadata: metadata,
  })

  if (error) throw error
}
