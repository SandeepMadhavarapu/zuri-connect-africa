import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';
if (!APP_ORIGIN) console.warn('[create-chama-group] APP_ORIGIN not set - CORS will be restrictive');

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

// Validation bounds. NAME_MIN/MAX mirror the chama_groups.name DB CHECK
// (char_length BETWEEN 3 AND 80) so the caller gets a clean 400 instead of a
// raw DB CHECK violation. DESC_MAX / CURRENCY_MAX are application-level caps to
// reject abusive payloads before they reach the DB.
const NAME_MIN = 3;
const NAME_MAX = 80;
const DESC_MAX = 500;
const CURRENCY_MAX = 8;

Deno.serve(async (req) => {
  // ── 1. CORS + method guard ──────────────────────────────────────────────
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const envCheck = requireFunctionEnv({
    functionName: 'create-chama-group',
    required: ['APP_ORIGIN'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  // ── 2. JWT auth ─────────────────────────────────────────────────────────
  // Identity is derived ONLY from the verified token. The authenticated user is
  // created_by AND the first member. A user id is never read from the body.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'MISSING_AUTHORIZATION' }, 401);

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userRes, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
  if (authErr || !userRes.user) return json({ ok: false, error: 'INVALID_TOKEN' }, 401);

  const authUserId = userRes.user.id;

  // ── 3. Parse body ───────────────────────────────────────────────────────
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  // ── 4. Validate input server-side ───────────────────────────────────────
  // name: required, trimmed, 3..80 chars (mirrors the DB CHECK).
  const name = String(body.name ?? '').trim();
  if (!name) return json({ ok: false, error: 'NAME_REQUIRED' }, 400);
  if (name.length < NAME_MIN || name.length > NAME_MAX) {
    return json({ ok: false, error: 'NAME_INVALID', message: `Name must be ${NAME_MIN}-${NAME_MAX} characters.` }, 400);
  }

  // description: optional, trimmed, capped. Empty/whitespace becomes null.
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    const desc = String(body.description).trim();
    if (desc.length > DESC_MAX) {
      return json({ ok: false, error: 'DESCRIPTION_TOO_LONG', message: `Description must be <= ${DESC_MAX} characters.` }, 400);
    }
    description = desc.length > 0 ? desc : null;
  }

  // currency: optional, defaults 'KES'. Must be a short currency code — reject
  // arbitrary long strings. Uppercased for consistency.
  let currency = 'KES';
  if (body.currency !== undefined && body.currency !== null) {
    const cur = String(body.currency).trim().toUpperCase();
    if (cur.length > 0) {
      if (cur.length > CURRENCY_MAX || !/^[A-Z]{3,8}$/.test(cur)) {
        return json({ ok: false, error: 'CURRENCY_INVALID', message: 'Currency must be a short currency code (e.g. KES).' }, 400);
      }
      currency = cur;
    }
  }

  // ── 5. Rate-limit check ──────────────────────────────────────────────────
  // Atomic, row-locking check via the shared check_rate_limit RPC (the same
  // mechanism the OTP/auth path uses) — replaces the old non-atomic read-then-act
  // COUNT, which a concurrent burst from one JWT could race past. A user may
  // create at most 5 groups per hour. The 'chama_group_create' endpoint is a
  // distinct bucket, keeping this limit independent of the other chama and auth
  // limits. checkRateLimit fails closed (denies) on RPC error.
  const rl = await checkRateLimit(supabaseAdmin, authUserId, 'user', 'chama_group_create', 5, 3600);
  if (!rl.allowed) {
    return json({ ok: false, error: 'RATE_LIMITED', retryAfterSeconds: rl.retryAfterSeconds }, 429);
  }

  // ── 6. Atomic create via SECURITY DEFINER RPC ────────────────────────────
  // The group insert + member insert are all-or-nothing inside create_chama_group.
  // The authenticated user id is passed explicitly (never trusted from the body).
  const { data: group, error: rpcErr } = await supabaseAdmin.rpc('create_chama_group', {
    p_user_id:     authUserId,
    p_name:        name,
    p_description: description,
    p_currency:    currency,
  });

  if (rpcErr || !group) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'create-chama-group',
      evt: 'create_group_failed',
      user_id: authUserId,
      error_code: rpcErr?.code ?? 'NO_ROW',
    }));
    return json({ ok: false, error: 'GROUP_CREATE_FAILED' }, 500);
  }

  console.info(JSON.stringify({
    ts: new Date().toISOString(),
    fn: 'create-chama-group',
    evt: 'group_created',
    user_id: authUserId,
    group_id: (group as Record<string, unknown>).id,
  }));

  // ── 7. Success ───────────────────────────────────────────────────────────
  const g = group as Record<string, unknown>;
  return json({
    ok: true,
    group: {
      id:          g.id,
      name:        g.name,
      description: g.description,
      currency:    g.currency,
      status:      g.status,
      created_at:  g.created_at,
    },
  });
});
