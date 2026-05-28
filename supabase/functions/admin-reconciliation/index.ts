/**
 * Zuri Connect Africa — admin reconciliation command center.
 * Deno entry point: wires real env + Supabase admin into `handleAdminReconciliation`.
 *
 * All authorisation + business logic lives in `./handler.ts` so the dispatcher
 * is unit-testable from Node (vitest).
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { isDarajaQueryConfigured } from '../_shared/payment-env.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import { handleAdminReconciliation } from './handler.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin':  APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const envCheck = requireFunctionEnv({
    functionName: 'admin-reconciliation',
    required:       ['APP_ORIGIN'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const url        = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await handleAdminReconciliation(req, {
    supabaseAdmin,
    providerQueryConfigured: isDarajaQueryConfigured(),
  });

  return Response.json(result.body, { status: result.status, headers: corsHeaders });
});
