import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

/**
 * @typedef {Object} ProviderResult
 * @property {string} provider_id
 * @property {string} provider_name
 * @property {string} provider_category
 * @property {string} method_type
 * @property {string} shortcode
 * @property {string|null} account_reference_label
 * @property {string|null} account_reference_format
 * @property {string} last_verified_at
 */

/**
 * Search the verified provider directory via the provider-search Edge Function.
 *
 * Returns a structured result — never throws. On any error, the caller gets
 * { results: [], count: 0, error: '<error_code>' } so the UI can fall back
 * to a local list without an unhandled rejection bubbling to the React tree.
 *
 * @param {string} query
 * @param {'paybill'|'till'} methodType
 * @param {number} limit
 * @returns {Promise<{ results: ProviderResult[], count: number, error?: string }>}
 */
export async function searchProviders(query = '', methodType = 'paybill', limit = 10) {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.functions.invoke('provider-search', {
      body: { query, method_type: methodType, limit },
    });

    if (error) {
      const status = error?.context?.status;
      if (status === 429) return { results: [], count: 0, error: 'rate_limited' };
      if (status === 401 || status === 403) return { results: [], count: 0, error: 'auth_failed' };
      return { results: [], count: 0, error: 'network_error' };
    }

    return {
      results: data?.results ?? [],
      count: data?.count ?? 0,
    };
  } catch {
    return { results: [], count: 0, error: 'network_error' };
  }
}
