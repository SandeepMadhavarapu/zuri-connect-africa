/**
 * provider-search — Edge Function
 *
 * Purpose : Full-text search over the verified provider directory.
 * Input   : POST  { query: string (1–100 chars),
 *                   method_type?: 'paybill'|'till'|'send_money'|'partner_api',
 *                   limit?: number (1–25, default 10; values >25 clamped to 25) }
 * Output  : { results: ProviderResult[], count: number }
 * Auth    : Bearer JWT required. Returns 401 if missing or invalid.
 * Security: Data queries run under the caller's JWT so Postgres RLS enforces
 *           visibility — only verified payment methods on active providers are
 *           ever returned. The service-role key is used solely for the
 *           rate-limit RPC (check_rate_limit), never for data reads.
 * Rate    : 30 requests / minute per authenticated user → 429 if exceeded.
 * Errors  : 400 invalid_input | 401 unauthorized | 429 rate_limited | 500 database_error
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { z } from 'npm:zod';
import { requireAuth, isAuthResult } from '../_shared/auth.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

// Exported so unit tests can exercise the validation surface without Deno globals.
export const searchSchema = z.object({
  query: z.string().min(1, 'query required').max(100, 'query too long'),
  method_type: z.enum(['paybill', 'till', 'send_money', 'partner_api']).optional(),
  limit: z
    .number()
    .int()
    .min(1, 'limit must be a positive integer')
    .default(10)
    .transform((v) => Math.min(v, 25)),
});

export type SearchInput = z.infer<typeof searchSchema>;

type RawRow = {
  provider_id: string;
  method_type: string;
  shortcode: string;
  account_reference_label: string | null;
  account_reference_format: string | null;
  last_verified_at: string;
  providers: { id: string; name: string; category: string } | null;
};

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authResult = await requireAuth(req);
  if (!isAuthResult(authResult)) {
    // Re-wrap with CORS headers so browsers can read the 401 body cross-origin.
    return new Response(authResult.body, {
      status: authResult.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
  const userId = authResult.userId;

  // ── Input validation ───────────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: 'invalid_input', details: 'request body must be valid JSON' }, 400);
  }

  const parsed = searchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return json({ error: 'invalid_input', details: parsed.error.flatten() }, 400);
  }
  const { query, method_type, limit } = parsed.data;

  // ── Rate limit (service-role RPC only) ────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rl = await checkRateLimit(supabaseAdmin, userId, 'user', 'provider-search', 30, 60);
  if (!rl.allowed) {
    return json({ error: 'rate_limited' }, 429);
  }

  // ── Database query (user JWT so RLS is enforced) ───────────────────────────
  const authHeader   = req.headers.get('Authorization') ?? '';
  const supabaseUser = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  try {
    // Escape ILIKE wildcards in user-supplied input to prevent pattern injection.
    const safeQ = query.replace(/[%_\\]/g, (c) => `\\${c}`);

    let dbQuery = supabaseUser
      .from('provider_payment_methods')
      .select(`
        provider_id,
        method_type,
        shortcode,
        account_reference_label,
        account_reference_format,
        last_verified_at,
        providers!inner(id, name, category)
      `)
      .eq('verification_status', 'verified')
      .or(`shortcode.ilike.%${safeQ}%,providers.name.ilike.%${safeQ}%`);

    if (method_type) {
      dbQuery = dbQuery.eq('method_type', method_type);
    }

    const { data, error } = await dbQuery
      .order('name', { referencedTable: 'providers', ascending: true })
      .limit(limit);

    if (error) {
      console.error('[provider-search] db_error', { userId, code: error.code });
      return json({ error: 'database_error' }, 500);
    }

    const results = ((data ?? []) as RawRow[]).map((row) => ({
      provider_id:              row.provider_id,
      provider_name:            row.providers?.name ?? '',
      provider_category:        row.providers?.category ?? '',
      method_type:              row.method_type,
      shortcode:                row.shortcode,
      account_reference_label:  row.account_reference_label ?? null,
      account_reference_format: row.account_reference_format ?? null,
      last_verified_at:         row.last_verified_at,
    }));

    console.log(JSON.stringify({
      ts:           new Date().toISOString(),
      fn:           'provider-search',
      user_id:      userId,
      query:        query.slice(0, 50),
      method_type:  method_type ?? null,
      result_count: results.length,
    }));

    return json({ results, count: results.length });
  } catch (err) {
    console.error('[provider-search] unexpected_error', {
      userId,
      msg: err instanceof Error ? err.message.slice(0, 80) : 'unknown',
    });
    return json({ error: 'database_error' }, 500);
  }
});
