import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { isSupabaseConfigured } from '@/config/env.js';

export async function triggerReconciliation() {
  if (!isSupabaseConfigured) return { ok: false, skipped: true };
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.functions.invoke('reconciliation-job', { body: {} });
    if (error) return { ok: false, error: error.message };
    return data;
  } catch (e) {
    return { ok: false, error: e?.message };
  }
}

export async function fetchRecentRuns(limit = 20) {
  if (!isSupabaseConfigured) return [];
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from('reconciliation_runs')
      .select('*')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

export async function fetchAnomalies(limit = 50) {
  if (!isSupabaseConfigured) return [];
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from('reconciliation_runs')
      .select('*')
      .eq('status', 'anomaly_detected')
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}
