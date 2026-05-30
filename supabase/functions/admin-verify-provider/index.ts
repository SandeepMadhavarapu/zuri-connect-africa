/**
 * admin-verify-provider — Edge Function
 *
 * Purpose : Admin-only write path to atomically verify a provider payment method.
 *           Delegates all three table writes to a single SECURITY DEFINER Postgres
 *           function (verify_provider_payment_method) so they execute in one
 *           transaction and either all succeed or all roll back.
 * Input   : POST { payment_method_id, source_type, source_reference,
 *                  evidence_hash?, attestation?, notes? }
 * Output  : { payment_method_id, verification_source_id, audit_event_id, verified_at }
 * Auth    : Bearer JWT required + app_metadata.role === 'admin'. 401/403 otherwise.
 * Security: The Postgres function runs SECURITY DEFINER (service_role). This Edge
 *           Function enforces the admin role check in application code before
 *           making any RPC call. source_reference and attestation are never logged
 *           as they may contain PII or sensitive evidence details.
 * Errors  : 400 invalid_input | 401 unauthorized | 403 forbidden |
 *           404 payment_method_not_found | 500 database_error
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { z } from 'npm:zod';
import { requireAdminRole } from '../_shared/admin-roles.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin':  APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

const SOURCE_TYPES = [
  'safaricom_directory',
  'provider_letter',
  'utility_invoice',
  'field_visit',
  'partner_api',
  'signed_contract',
] as const;

// Exported so unit tests can exercise the validation surface without Deno globals.
export const verifySchema = z.object({
  payment_method_id: z.string().uuid('payment_method_id must be a valid UUID'),
  source_type: z.enum(SOURCE_TYPES),
  source_reference: z
    .string()
    .min(5, 'source_reference too short')
    .max(500, 'source_reference too long'),
  evidence_hash: z
    .string()
    .max(200, 'evidence_hash too long')
    .regex(/^[0-9a-fA-F]+$/, 'evidence_hash must be hex')
    .optional(),
  attestation: z.record(z.unknown()).default({}),
  notes: z
    .string()
    .max(500, 'notes too long')
    .optional(),
});

export type VerifyInput = z.infer<typeof verifySchema>;

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  // service_role client — used for both the admin role check and the RPC call.
  // The Postgres function is SECURITY DEFINER and REVOKE'd from authenticated/anon,
  // so service_role is the only client that can invoke it.
  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Admin role check (must precede all writes) ────────────────────────────
  // Role is read exclusively from app_metadata.role — never from user_metadata.
  const auth = await requireAdminRole(supabaseAdmin, req, ['admin']);
  if (!auth.ok) {
    if (auth.status === 401) {
      return json({ error: auth.error }, 401);
    }
    return json({ error: 'forbidden', reason: 'admin_required' }, 403);
  }
  const adminUserId = auth.user.id;

  // ── Input validation ───────────────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: 'invalid_input', details: 'request body must be valid JSON' }, 400);
  }

  const parsed = verifySchema.safeParse(rawBody);
  if (!parsed.success) {
    return json({ error: 'invalid_input', details: parsed.error.flatten() }, 400);
  }
  const {
    payment_method_id,
    source_type,
    source_reference,
    evidence_hash,
    attestation,
    notes,
  } = parsed.data;

  // ── Atomic RPC (service_role — Postgres function runs SECURITY DEFINER) ───
  const { data, error } = await supabaseAdmin.rpc('verify_provider_payment_method', {
    p_payment_method_id: payment_method_id,
    p_admin_user_id:     adminUserId,
    p_source_type:       source_type,
    p_source_reference:  source_reference,
    p_evidence_hash:     evidence_hash ?? null,
    p_attestation:       attestation,
    p_notes:             notes ?? null,
  });

  if (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === 'P0002') {
      return json({ error: 'payment_method_not_found' }, 404);
    }
    // Defense in depth: Zod should have caught this; map it anyway.
    if (code === '22023') {
      return json({ error: 'invalid_input', details: 'invalid_source_type' }, 400);
    }
    console.error('[admin-verify-provider] db_error', {
      adminUserId,
      payment_method_id,
      code,
    });
    return json({ error: 'database_error' }, 500);
  }

  // source_reference and attestation are intentionally omitted — they may
  // contain PII or sensitive evidence details.
  console.log(JSON.stringify({
    ts:               new Date().toISOString(),
    fn:               'admin-verify-provider',
    admin_user_id:    adminUserId,
    payment_method_id,
    source_type,
    audit_event_id:   (data as Record<string, unknown>)?.audit_event_id ?? null,
  }));

  return json(data as Record<string, unknown>);
});
