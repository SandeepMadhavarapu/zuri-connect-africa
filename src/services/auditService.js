import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { isSupabaseConfigured } from '@/config/env.js';

/**
 * Server-persisted audit event writer.
 * Fail-open: never breaks the calling flow.
 */
export async function persistAuditEvent(event) {
  if (!isSupabaseConfigured) return { ok: false, skipped: true };
  try {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.from('audit_events').insert({
      event_type: event.eventType || 'unknown',
      event_category: event.category || 'system',
      severity: event.severity || 'info',
      actor_id: event.actorId || null,
      actor_type: event.actorType || 'user',
      actor_ip: event.actorIp || null,
      target_type: event.targetType || null,
      target_id: event.targetId || null,
      action: event.action || 'unknown',
      outcome: event.outcome || 'success',
      payload: event.payload || {},
      payload_hash: '',
      correlation_id: event.correlationId || null,
      session_id: event.sessionId || null,
    });
    if (error) {
      console.warn('[audit] persist error:', error.message);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[audit] exception:', e?.message);
    return { ok: false };
  }
}

/**
 * Verify the audit chain integrity. Returns { valid, broken_at_sequence?, total_checked }.
 */
export async function verifyAuditChain(startSeq = null, endSeq = null) {
  if (!isSupabaseConfigured) return { valid: false, skipped: true };
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.rpc('verify_audit_chain', {
      p_start_sequence: startSeq,
      p_end_sequence: endSeq,
    });
    if (error) return { valid: false, error: error.message };
    return data;
  } catch (e) {
    return { valid: false, error: e?.message };
  }
}

/**
 * Fetch recent audit events for current user (RLS limits to own records).
 */
export async function fetchOwnAuditEvents(limit = 100) {
  if (!isSupabaseConfigured) return [];
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from('audit_events')
      .select('*')
      .order('sequence_number', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}
