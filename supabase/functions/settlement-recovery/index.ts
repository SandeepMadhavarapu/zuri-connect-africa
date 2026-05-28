import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';
const ADMIN_ROLES = new Set(['admin', 'auditor']);

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  const url        = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) {
    return Response.json({ ok: false, error: 'service_not_configured' }, { status: 500, headers: corsHeaders });
  }

  // ── 1. Require authenticated user ────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return Response.json({ ok: false, error: 'missing_authorization' }, { status: 401, headers: corsHeaders });
  }

  const supabaseAdmin = createClient(url, serviceKey);
  const { data: userRes, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
  if (authErr || !userRes.user) {
    return Response.json({ ok: false, error: 'invalid_token' }, { status: 401, headers: corsHeaders });
  }

  // ── 2. Require admin role ────────────────────────────────────────────────
  const role = ((userRes.user.app_metadata?.role) ?? '').toLowerCase();
  if (!ADMIN_ROLES.has(role)) {
    return Response.json({ ok: false, error: 'forbidden', message: 'Insufficient privileges.' }, { status: 403, headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    return Response.json({ ok: true, recovered: false, detail: body }, { headers: corsHeaders });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: corsHeaders });
  }
});
