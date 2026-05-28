/**
 * Legacy compatibility wrapper around the canonical Supabase browser client.
 * Keeps env-driven wiring in one place (`src/lib/supabase/client.js`) and
 * avoids parallel client initialization paths.
 */

import { env, isSupabaseConfigured } from '@/config/env.js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

export const SUPABASE_CONFIGURED = isSupabaseConfigured;

function client() {
  return getSupabaseBrowserClient();
}

const supabase = new Proxy(
  {},
  {
    get(_target, prop) {
      return client()[prop];
    },
  }
);

export default supabase;
export { supabase };

/**
 * Execute a Supabase query and unwrap the result.
 * Returns { data, error } consistently — never throws.
 */
export async function supabaseQuery(queryFn) {
  try {
    const result = await queryFn(client());
    return { data: result?.data ?? null, error: result?.error ?? null };
  } catch (err) {
    return { data: null, error: { message: err?.message || 'unknown_error', code: 'QUERY_ERROR' } };
  }
}

/**
 * Paginated fetch helper — fetches all rows by iterating over pages.
 */
export async function fetchAllPages(table, modifier = null, pageSize = 1000) {
  const rows = [];
  let from = 0;
  let done = false;

  while (!done) {
    let q = client().from(table).select('*').range(from, from + pageSize - 1);
    if (modifier) q = modifier(q);

    const { data, error } = await q;
    if (error) return { data: rows, error };
    if (!data || data.length === 0) break;

    rows.push(...data);
    done = data.length < pageSize;
    from += pageSize;
  }

  return { data: rows, error: null };
}

const channelRegistry = new Map();

/**
 * Realtime subscription helper with duplicate-channel cleanup.
 */
export function subscribeToTable(channel, table, event, handler, filter = null) {
  if (!SUPABASE_CONFIGURED) return () => {};

  const sb = client();

  const existing = channelRegistry.get(channel);
  if (existing) {
    try {
      sb.removeChannel(existing);
    } catch {
      /* ignore */
    }
  }

  const realtimeChannel = sb
    .channel(channel)
    .on('postgres_changes', { event, schema: 'public', table, ...(filter ? { filter } : {}) }, handler)
    .subscribe();

  channelRegistry.set(channel, realtimeChannel);

  return () => {
    try {
      sb.removeChannel(realtimeChannel);
    } catch {
      /* ignore */
    } finally {
      if (channelRegistry.get(channel) === realtimeChannel) {
        channelRegistry.delete(channel);
      }
    }
  };
}

export function getSupabaseConfigSnapshot() {
  return {
    configured: SUPABASE_CONFIGURED,
    supabaseUrl: env.supabaseUrl,
  };
}
