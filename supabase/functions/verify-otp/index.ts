import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import {
  getOtpPepper,
  hashOtpWithPepper,
  normalizeOtpPurpose,
} from '../_shared/otp-crypto.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/\s+/g, '').replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/^\+/, '');
  if (/^254[71]\d{8}$/.test(digits)) return digits;
  if (/^2540[71]\d{8}$/.test(digits)) return `254${digits.slice(4)}`;
  if (/^0[71]\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^[71]\d{8}$/.test(digits)) return `254${digits}`;
  throw new Error('Invalid phone number format');
}

async function writeSecurityEvent(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  payload: Record<string, unknown>
): Promise<void> {
  try {
    await supabaseAdmin.from('security_events').insert({
      user_id: payload.user_id ?? null,
      event_type: payload.event_type ?? 'otp.verify',
      severity: payload.severity ?? 'info',
      action: payload.action ?? 'verify_otp',
      outcome: payload.outcome ?? 'success',
      payload: payload.payload ?? {},
    });
  } catch {
    console.error('[verify-otp] security_events insert failed');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);
  }

  const envCheck = requireFunctionEnv({
    functionName: 'verify-otp',
    required:       ['APP_ORIGIN', 'OTP_PEPPER'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) {
    return json({ ok: false, error: 'OTP_SERVICE_UNAVAILABLE' }, 503);
  }
  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // OTP_PEPPER required — fail closed if missing.
  let pepperOk = true;
  try { getOtpPepper(); } catch { pepperOk = false; }
  if (!pepperOk) {
    return json({ ok: false, error: 'OTP_SERVICE_UNAVAILABLE' }, 503);
  }

  // IP-level rate limit: 20 / minute / IP.
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  const ipLimit = await checkRateLimit(supabaseAdmin, clientIp, 'ip', 'verify-otp', 20, 60, 0);
  if (!ipLimit.allowed) {
    return Response.json(
      { ok: false, error: 'rate_limited', retryAfterSeconds: ipLimit.retryAfterSeconds },
      { status: 429, headers: { ...corsHeaders, 'Retry-After': String(ipLimit.retryAfterSeconds) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }
  const phone = typeof body?.phone === 'string' ? body.phone : '';
  const otp = typeof body?.otp === 'string' || typeof body?.otp === 'number' ? String(body.otp) : '';
  const purpose = normalizeOtpPurpose(body?.purpose);
  if (!phone || !otp) {
    return json({ ok: false, error: 'PHONE_AND_OTP_REQUIRED' }, 400);
  }

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(phone);
  } catch {
    return json({ ok: false, error: 'INVALID_PHONE' }, 400);
  }

  // Phone-level rate limit: 10 attempts / 10 mins; block 30 mins.
  const phoneLimit = await checkRateLimit(
    supabaseAdmin, normalizedPhone, 'phone', 'verify-otp', 10, 600, 1800,
  );
  if (!phoneLimit.allowed) {
    await writeSecurityEvent(supabaseAdmin, {
      event_type: 'otp.rate_limited',
      severity: 'warn',
      action: 'verify_otp',
      outcome: 'denied',
      payload: {
        phone_suffix: normalizedPhone.slice(-4),
        purpose,
        blocked: phoneLimit.blocked,
      },
    });
    return Response.json(
      {
        ok: false,
        error: 'rate_limited',
        retryAfterSeconds: phoneLimit.retryAfterSeconds,
        blocked: phoneLimit.blocked,
      },
      { status: 429, headers: { ...corsHeaders, 'Retry-After': String(phoneLimit.retryAfterSeconds) } },
    );
  }

  // Compute the peppered HMAC for the (purpose, phone, otp) triple. The raw
  // OTP is never persisted or logged from this point on.
  let candidateHash: string;
  try {
    candidateHash = await hashOtpWithPepper(otp, normalizedPhone, purpose);
  } catch {
    return json({ ok: false, error: 'OTP_SERVICE_UNAVAILABLE' }, 503);
  }

  // If a valid bearer is present, capture the user id so consume_otp can
  // stamp `verified_user_id`. We DO NOT require a session here because OTP
  // is also used during pre-auth phone verification.
  let verifiedUserId: string | null = null;
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const userClient = createClient(url, anon, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: userData } = await userClient.auth.getUser();
      verifiedUserId = userData.user?.id ?? null;
    } catch {
      verifiedUserId = null;
    }
  }

  // Atomic single-use consumption — guarantees only one caller can ever
  // succeed for a given OTP row, even under concurrent retries.
  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('consume_otp', {
    p_phone: normalizedPhone,
    p_purpose: purpose,
    p_hash: candidateHash,
    p_max_attempts: 3,
    p_user_id: verifiedUserId,
  });

  if (rpcErr) {
    console.error('[verify-otp] consume_otp RPC failed:', rpcErr.message);
    return json({ ok: false, error: 'OTP_SERVICE_UNAVAILABLE' }, 503);
  }

  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  const outcome = String(row?.outcome ?? 'not_found');
  const attemptsAfter = Number(row?.attempts_after ?? 0);
  const phoneSuffix = normalizedPhone.slice(-4);

  if (outcome === 'consumed') {
    if (verifiedUserId) {
      // Phone verification path — bind auth.users.phone (service-role only).
      try {
        await supabaseAdmin.auth.admin.updateUserById(verifiedUserId, {
          phone: '+' + normalizedPhone,
        });
      } catch (e) {
        console.error('[verify-otp] phone bind failed', (e as Error)?.name);
        // Fall through: OTP itself was valid, but propagate a soft warning.
      }
    }
    await writeSecurityEvent(supabaseAdmin, {
      user_id: verifiedUserId,
      event_type: 'otp.verify.success',
      severity: 'info',
      action: 'verify_otp',
      outcome: 'success',
      payload: { phone_suffix: phoneSuffix, purpose },
    });
    return json({ ok: true, success: true });
  }

  if (outcome === 'expired') {
    await writeSecurityEvent(supabaseAdmin, {
      user_id: verifiedUserId,
      event_type: 'otp.verify.expired',
      severity: 'warn',
      action: 'verify_otp',
      outcome: 'failure',
      payload: { phone_suffix: phoneSuffix, purpose },
    });
    return json({ ok: false, success: false, error: 'OTP_EXPIRED' }, 410);
  }

  if (outcome === 'locked') {
    await writeSecurityEvent(supabaseAdmin, {
      user_id: verifiedUserId,
      event_type: 'otp.verify.locked',
      severity: 'warn',
      action: 'verify_otp',
      outcome: 'denied',
      payload: { phone_suffix: phoneSuffix, purpose, attempts: attemptsAfter },
    });
    return json({ ok: false, success: false, locked: true, error: 'OTP_LOCKED' }, 429);
  }

  if (outcome === 'already_consumed') {
    await writeSecurityEvent(supabaseAdmin, {
      user_id: verifiedUserId,
      event_type: 'otp.verify.reuse_attempt',
      severity: 'warn',
      action: 'verify_otp',
      outcome: 'denied',
      payload: { phone_suffix: phoneSuffix, purpose },
    });
    return json({ ok: false, success: false, error: 'OTP_ALREADY_USED' }, 409);
  }

  if (outcome === 'invalid') {
    const remaining = Math.max(0, 3 - attemptsAfter);
    await writeSecurityEvent(supabaseAdmin, {
      user_id: verifiedUserId,
      event_type: 'otp.verify.invalid',
      severity: 'warn',
      action: 'verify_otp',
      outcome: 'failure',
      payload: { phone_suffix: phoneSuffix, purpose, attempts: attemptsAfter, attemptsRemaining: remaining },
    });
    return json({ ok: false, success: false, attemptsRemaining: remaining });
  }

  // not_found / invalid_input / anything else — opaque failure.
  await writeSecurityEvent(supabaseAdmin, {
    user_id: verifiedUserId,
    event_type: 'otp.verify.not_found',
    severity: 'info',
    action: 'verify_otp',
    outcome: 'failure',
    payload: { phone_suffix: phoneSuffix, purpose, outcome },
  });
  return json({ ok: false, success: false, error: 'OTP_NOT_FOUND' }, 404);
});
