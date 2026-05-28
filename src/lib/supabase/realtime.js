import { getSupabaseBrowserClient } from './client.js';
import { isSupabaseConfigured } from '@/config/env.js';
import { METRICS, track } from '@/lib/observability/metrics.js';

const channelRegistry = new Map();

/**
 * Subscribe to Postgres changes on a channel (optional — feature-flagged).
 * Returns a no-op unsubscribe when Supabase is not configured or subscribe fails.
 */
export function subscribeLedgerChannel(onPayload) {
  if (!isSupabaseConfigured) {
    console.warn('[supabase/realtime] Skipping ledger subscription — Supabase not configured.');
    try {
      track(METRICS.SUPABASE_REALTIME_FAILURE, 1, { reason: 'not_configured' });
    } catch { /* ignore */ }
    return { unsubscribe: () => {}, error: null };
  }

  try {
    const supabase = getSupabaseBrowserClient();
    const existing = channelRegistry.get('ledger-realtime');
    if (existing) {
      try {
        supabase.removeChannel(existing);
      } catch {
        /* ignore */
      }
    }

    const channel = supabase
      .channel('ledger-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'ledger_entries' },
        onPayload
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          try {
            track(METRICS.SUPABASE_REALTIME_FAILURE, 1, { status: String(status) });
          } catch { /* ignore */ }
        }
      });
    channelRegistry.set('ledger-realtime', channel);
    return {
      unsubscribe: () => {
        try {
          supabase.removeChannel(channel);
          if (channelRegistry.get('ledger-realtime') === channel) {
            channelRegistry.delete('ledger-realtime');
          }
        } catch { /* ignore */ }
      },
      error: null,
    };
  } catch (e) {
    console.warn('[supabase/realtime] subscribe failed:', e?.message || e);
    try {
      track(METRICS.SUPABASE_REALTIME_FAILURE, 1, { reason: 'subscribe_throw' });
    } catch { /* ignore */ }
    return { unsubscribe: () => {}, error: e };
  }
}
