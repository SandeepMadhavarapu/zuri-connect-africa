import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

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
  const supabase   = createClient(url, serviceKey);

  // Require a valid Supabase JWT — unauthenticated callers cannot enqueue notifications.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return Response.json({ error: 'missing_authorization' }, { status: 401, headers: corsHeaders });
  }
  const { data: userRes, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !userRes.user) {
    return Response.json({ error: 'invalid_token' }, { status: 401, headers: corsHeaders });
  }
  // Enforce ownership: user_id in the inserted row is always the authenticated caller's id.
  // The body's user_id field is intentionally ignored to prevent cross-user notification injection.
  const userId = userRes.user.id;

  try {
    const body = await req.json();
    await supabase.from('notifications').insert({
      user_id: userId,
      channel: body?.channel ?? 'push',
      body:    body?.payload ?? {},
      status:  'queued',
    });

    return Response.json({ ok: true, dispatched: true }, { headers: corsHeaders });
  } catch (e) {
    console.error('notification-dispatcher', e);
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: corsHeaders });
  }
});
