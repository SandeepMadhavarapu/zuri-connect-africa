import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

const _cache = new Map();

/**
 * Fetch a snapshot from admin-soc-readonly Edge Function.
 *
 * Never throws — all errors are returned as { error: string }.
 * 30-second in-memory cache prevents rapid button-clicks from hammering
 * the Edge Function (which itself rate-limits at 60 req/min per caller).
 *
 * @param {string[] | undefined} panels  Optional panel-key filter.
 * @returns {Promise<{ generated_at: string, caller_role: string, panels: object } | { error: string }>}
 */
export async function fetchAdminSocSnapshot(panels) {
  const cacheKey = JSON.stringify(panels ?? null);
  const cached   = _cache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) {
    return cached.value;
  }

  try {
    const supabase = getSupabaseBrowserClient();
    const body     = panels ? { panels } : {};
    const { data, error } = await supabase.functions.invoke('admin-soc-readonly', { body });

    if (error) {
      const status = error?.context?.status;
      if (status === 429) return { error: 'rate_limited' };
      if (status === 401) return { error: 'auth_failed' };
      if (status === 403) return { error: 'forbidden' };
      return { error: 'network_error' };
    }

    const result = {
      generated_at: data?.generated_at ?? null,
      caller_role:  data?.caller_role  ?? null,
      panels:       data?.panels       ?? {},
    };

    _cache.set(cacheKey, { value: result, expires_at: Date.now() + 30_000 });
    return result;
  } catch {
    return { error: 'network_error' };
  }
}
