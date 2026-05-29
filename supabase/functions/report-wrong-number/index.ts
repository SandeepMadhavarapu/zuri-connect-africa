/**
 * report-wrong-number — Edge Function
 *
 * Purpose : Accept user-filed reports of incorrect shortcodes in the provider directory.
 * Input   : POST  { payment_method_id: uuid (required),
 *                   alleged_correct_shortcode?: string (max 20 chars),
 *                   reason: string (10–500 chars, required) }
 * Output  : { id: uuid, status: 'open', received_at: ISO timestamp }
 * Auth    : Bearer JWT required. Returns 401 if missing or invalid.
 * Security: All database queries run under the caller's JWT so RLS enforces
 *           reporter_user_id = auth.uid() on inserts and restricts the rate-limit
 *           count to the caller's own rows. No service-role key is used.
 * Rate    : 3 reports per user per rolling 24 hours → 429 if exceeded.
 * Errors  : 400 invalid_input | 401 unauthorized | 404 payment_method_not_found |
 *           429 rate_limited | 500 database_error
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { z } from 'npm:zod';
import { requireAuth, isAuthResult } from '../_shared/auth.ts';

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
export const reportSchema = z.object({
  payment_method_id: z.string().uuid('payment_method_id must be a valid UUID'),
  alleged_correct_shortcode: z
    .string()
    .max(20, 'alleged_correct_shortcode too long')
    .optional(),
  reason: z
    .string()
    .min(10, 'reason too short')
    .max(500, 'reason too long'),
});

export type ReportInput = z.infer<typeof reportSchema>;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authResult = await requireAuth(req);
  if (!isAuthResult(authResult)) {
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

  const parsed = reportSchema.safeParse(rawBody);
  if (!parsed.success) {
    return json({ error: 'invalid_input', details: parsed.error.flatten() }, 400);
  }
  const { payment_method_id, alleged_correct_shortcode, reason } = parsed.data;

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const authHeader  = req.headers.get('Authorization') ?? '';

  // Single user-JWT client for all DB operations — RLS enforces ownership.
  const supabaseUser = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });

  // ── Rate limit (user JWT — RLS restricts count to caller's own rows) ──────
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count, error: countError } = await supabaseUser
    .from('provider_wrong_number_reports')
    .select('id', { count: 'exact', head: true })
    .eq('reporter_user_id', userId)
    .gte('created_at', since);

  if (countError) {
    console.error('[report-wrong-number] rate_limit_check_error', { userId });
    return json({ error: 'database_error' }, 500);
  }

  if ((count ?? 0) >= 3) {
    return json({ error: 'rate_limited', reason: 'daily_limit_exceeded' }, 429);
  }

  // ── Validate payment_method_id exists ─────────────────────────────────────
  const { data: pmRow, error: pmError } = await supabaseUser
    .from('provider_payment_methods')
    .select('id')
    .eq('id', payment_method_id)
    .maybeSingle();

  if (pmError || !pmRow) {
    return json({ error: 'payment_method_not_found' }, 404);
  }

  // ── Insert report (user JWT → RLS enforces reporter_user_id = auth.uid()) ─
  const { data: insertData, error: insertError } = await supabaseUser
    .from('provider_wrong_number_reports')
    .insert({
      payment_method_id,
      reporter_user_id:          userId,
      alleged_correct_shortcode: alleged_correct_shortcode ?? null,
      reason,
    })
    .select('id, status, created_at')
    .single();

  if (insertError || !insertData) {
    console.error('[report-wrong-number] insert_error', { userId });
    return json({ error: 'database_error' }, 500);
  }

  console.log(JSON.stringify({
    ts:                        new Date().toISOString(),
    fn:                        'report-wrong-number',
    user_id:                   userId,
    payment_method_id,
    alleged_correct_shortcode: alleged_correct_shortcode ?? 'none',
    report_id:                 insertData.id,
  }));

  return json(
    {
      id:          insertData.id,
      status:      insertData.status,
      received_at: insertData.created_at,
    },
    201,
  );
});
