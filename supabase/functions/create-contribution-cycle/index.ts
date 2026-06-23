import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';
if (!APP_ORIGIN) console.warn('[create-contribution-cycle] APP_ORIGIN not set - CORS will be restrictive');

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

// Validation bounds. NAME_MIN/MAX mirror the chama_groups.name convention reused
// for cycle names (3..80). MAX_AMOUNT_CENTS rejects absurd payloads before the DB
// CHECK (amount_cents > 0) backstop. MAX_GRACE_DAYS caps the optional grace window.
const NAME_MIN = 3;
const NAME_MAX = 80;
const MAX_AMOUNT_CENTS = 100_000_000; // 1,000,000 KES — well above any real cycle.
const DEFAULT_GRACE_DAYS = 3;
const MAX_GRACE_DAYS = 30;

// Roles permitted to open a contribution cycle. A plain member cannot.
const AUTHORIZED_ROLES = new Set(['chair', 'treasurer']);

// RPC error string → HTTP status. Anything not listed maps to 500 below.
const RPC_ERROR_STATUS: Record<string, number> = {
  OPEN_CYCLE_EXISTS: 409,
  CYCLE_NAME_EXISTS: 409,
  NO_ACTIVE_MEMBERS: 422,
  GROUP_NOT_FOUND:   404,
  GROUP_NOT_ACTIVE:  409,
  AMOUNT_INVALID:    400,
};

Deno.serve(async (req) => {
  // ── 1. CORS + method guard ──────────────────────────────────────────────
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const envCheck = requireFunctionEnv({
    functionName: 'create-contribution-cycle',
    required: ['APP_ORIGIN'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  // ── 2. JWT auth ─────────────────────────────────────────────────────────
  // Identity is derived ONLY from the verified token. The authenticated user is
  // created_by. A user id is never read from the body.
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

  // group_id: required non-empty string.
  const groupId = String(body.group_id ?? '').trim();
  if (!groupId) return json({ ok: false, error: 'GROUP_ID_REQUIRED' }, 400);

  // name: required, trimmed, 3..80 chars.
  const name = String(body.name ?? '').trim();
  if (!name || name.length < NAME_MIN || name.length > NAME_MAX) {
    return json({ ok: false, error: 'NAME_INVALID', message: `Name must be ${NAME_MIN}-${NAME_MAX} characters.` }, 400);
  }

  // amount: accept amount_kes (preferred) OR amount_cents. KES→cents conversion
  // happens ONLY here at the Edge boundary; the DB always stores integer cents.
  // Money is never a float past this point.
  let amountCents: number;
  if (body.amount_kes !== undefined && body.amount_kes !== null) {
    const kes = Number(body.amount_kes);
    if (!Number.isFinite(kes)) {
      return json({ ok: false, error: 'AMOUNT_INVALID', message: 'Amount must be a number.' }, 400);
    }
    amountCents = Math.round(kes * 100);
  } else if (body.amount_cents !== undefined && body.amount_cents !== null) {
    const cents = Number(body.amount_cents);
    if (!Number.isInteger(cents)) {
      return json({ ok: false, error: 'AMOUNT_INVALID', message: 'amount_cents must be an integer.' }, 400);
    }
    amountCents = cents;
  } else {
    return json({ ok: false, error: 'AMOUNT_INVALID', message: 'amount_kes or amount_cents is required.' }, 400);
  }
  if (amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    return json({ ok: false, error: 'AMOUNT_INVALID', message: 'Amount is out of the allowed range.' }, 400);
  }

  // due_date: required, parseable, and strictly in the future.
  const dueRaw = String(body.due_date ?? '').trim();
  if (!dueRaw) return json({ ok: false, error: 'DUE_DATE_INVALID', message: 'due_date is required.' }, 400);
  const dueMs = new Date(dueRaw).getTime();
  if (Number.isNaN(dueMs) || dueMs <= Date.now()) {
    return json({ ok: false, error: 'DUE_DATE_INVALID', message: 'due_date must be a valid future date.' }, 400);
  }
  const dueAtIso = new Date(dueMs).toISOString();

  // grace_days: optional, default 3, integer 0..30.
  let graceDays = DEFAULT_GRACE_DAYS;
  if (body.grace_days !== undefined && body.grace_days !== null) {
    const g = Number(body.grace_days);
    if (!Number.isInteger(g) || g < 0 || g > MAX_GRACE_DAYS) {
      return json({ ok: false, error: 'GRACE_DAYS_INVALID', message: `grace_days must be an integer 0-${MAX_GRACE_DAYS}.` }, 400);
    }
    graceDays = g;
  }

  // ── 5. Authorization: caller must be an active chair/treasurer ───────────
  // A regular member cannot open a cycle. Read membership/role the same way
  // chama-contribute reads it (chama_members scoped to group + user).
  const { data: membership, error: memberErr } = await supabaseAdmin
    .from('chama_members')
    .select('role, status')
    .eq('group_id', groupId)
    .eq('user_id', authUserId)
    .eq('status', 'active')
    .maybeSingle();

  if (memberErr) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'create-contribution-cycle',
      evt: 'membership_lookup_failed',
      user_id: authUserId,
      error_code: memberErr.code,
    }));
    return json({ ok: false, error: 'INTERNAL_ERROR' }, 500);
  }

  if (!membership || !AUTHORIZED_ROLES.has(String(membership.role))) {
    return json({ ok: false, error: 'NOT_AUTHORIZED', message: 'Only an active chair or treasurer can open a cycle.' }, 403);
  }

  // ── 6. Rate-limit check ──────────────────────────────────────────────────
  // Atomic, row-locking check via the shared check_rate_limit RPC (the same
  // mechanism the OTP/auth path uses) — replaces the old non-atomic read-then-act
  // COUNT, which a concurrent burst from one JWT could race past. A user may
  // create at most 10 cycles per hour. The 'chama_cycle_create' endpoint is a
  // distinct bucket, keeping this limit independent of the other chama and auth
  // limits. checkRateLimit fails closed (denies) on RPC error.
  const rl = await checkRateLimit(supabaseAdmin, authUserId, 'user', 'chama_cycle_create', 10, 3600);
  if (!rl.allowed) {
    return json({ ok: false, error: 'RATE_LIMITED', retryAfterSeconds: rl.retryAfterSeconds }, 429);
  }

  // ── 7. Atomic create via SECURITY DEFINER RPC ────────────────────────────
  // The cycle insert + obligation generation are all-or-nothing inside
  // create_contribution_cycle. The one-open-cycle invariant is enforced in-RPC.
  // The authenticated user id is passed explicitly (never trusted from the body).
  const { data: result, error: rpcErr } = await supabaseAdmin.rpc('create_contribution_cycle', {
    p_user_id:      authUserId,
    p_group_id:     groupId,
    p_name:         name,
    p_amount_cents: amountCents,
    p_due_at:       dueAtIso,
    p_grace_days:   graceDays,
  });

  if (rpcErr || !result) {
    // Map known RPC error strings to clean HTTP statuses; everything else 500.
    const rawMessage = rpcErr?.message ?? '';
    const matchedCode = Object.keys(RPC_ERROR_STATUS).find((code) => rawMessage.includes(code));

    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'create-contribution-cycle',
      evt: 'create_cycle_failed',
      user_id: authUserId,
      group_id: groupId,
      error_code: matchedCode ?? rpcErr?.code ?? 'NO_ROW',
    }));

    if (matchedCode) {
      return json({ ok: false, error: matchedCode }, RPC_ERROR_STATUS[matchedCode]);
    }
    return json({ ok: false, error: 'CYCLE_CREATE_FAILED' }, 500);
  }

  // ── 8. Success ───────────────────────────────────────────────────────────
  const r = result as Record<string, unknown>;
  const obligationCount = r.obligation_count;

  console.info(JSON.stringify({
    ts: new Date().toISOString(),
    fn: 'create-contribution-cycle',
    evt: 'cycle_created',
    user_id: authUserId,
    group_id: groupId,
    cycle_id: r.id,
    obligation_count: obligationCount,
  }));

  return json({
    ok: true,
    cycle: {
      id:           r.id,
      group_id:     r.group_id,
      name:         r.name,
      amount_cents: r.amount_cents,
      currency:     r.currency,
      due_at:       r.due_at,
      grace_days:   r.grace_days,
      status:       r.status,
      created_by:   r.created_by,
      created_at:   r.created_at,
    },
    obligation_count: obligationCount,
  });
});
