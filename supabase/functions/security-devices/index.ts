/**
 * Zuri Connect Africa — security-devices Edge Function entry.
 *
 * The HTTP dispatcher lives in `handler.ts` and is the only file imported by
 * the Node/Vitest test runner. This file is the Deno-only wrapper that wires
 * in the real Supabase admin client + env validation.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { handleSecurityDevices } from './handler.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin':  APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: corsHeaders });
  }

  const envCheck = requireFunctionEnv({
    functionName: 'security-devices',
    required:       ['APP_ORIGIN', 'DEVICE_FINGERPRINT_PEPPER'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const url        = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // IP-based throttle so the endpoint can't be hammered by an unauth caller
  // probing for valid device ids.
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  const ipLimit = await checkRateLimit(supabaseAdmin, clientIp, 'ip', 'security-devices', 60, 60, 0);
  if (!ipLimit.allowed) {
    return Response.json(
      { ok: false, error: 'rate_limited', retryAfterSeconds: ipLimit.retryAfterSeconds },
      { status: 429, headers: corsHeaders },
    );
  }

  const result = await handleSecurityDevices(req, { supabaseAdmin });
  return Response.json(result.body, { status: result.status, headers: corsHeaders });
});
