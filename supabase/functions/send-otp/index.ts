import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import {
  generateNumericOtp,
  getOtpPepper,
  hashOtpWithPepper,
  normalizeOtpPurpose,
  OTP_HASH_VERSION,
} from '../_shared/otp-crypto.ts';
import { requireFunctionEnv } from '../_shared/function-env.ts';
import {
  buildAfricaTalkingSmsBody,
  mapProviderStatusToPublicCode,
  maskPhoneSuffix,
  providerRecipientAccepted,
  readProviderDiagnostics,
  resolveAfricaTalkingConfig,
  type OtpProviderPublicCode,
} from '../_shared/otp-provider-diagnostics.ts';

// CORS hardening:
//   * No wildcard. APP_ORIGIN must be set in production/staging; if missing,
//     we return the special "null" origin token so browsers refuse cross-site
//     credentialed requests instead of silently allowing any caller.
//   * Methods are pinned to POST + OPTIONS.
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

function statusForPublicCode(code: OtpProviderPublicCode): number {
  if (code === 'SMS_PROVIDER_RATE_LIMITED') return 429;
  if (code === 'SMS_PROVIDER_MISCONFIGURED' || code === 'OTP_SERVICE_UNAVAILABLE') return 503;
  return 502;
}

function publicFailure(code: OtpProviderPublicCode) {
  return json({ ok: false, success: false, error: code }, statusForPublicCode(code));
}

function logProviderDiagnostic(event: string, details: Record<string, unknown>) {
  console.error(`[send-otp] ${event}`, details);
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
      event_type: payload.event_type ?? 'otp.send',
      severity: payload.severity ?? 'info',
      action: payload.action ?? 'send_otp',
      outcome: payload.outcome ?? 'success',
      payload: payload.payload ?? {},
    });
  } catch (e) {
    // Best-effort log — never leak details to the caller.
    console.error('[send-otp] security_events insert failed');
    void e;
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
    functionName: 'send-otp',
    required:       ['APP_ORIGIN', 'OTP_PEPPER'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return publicFailure('OTP_SERVICE_UNAVAILABLE');

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!url || !serviceKey) {
    return publicFailure('OTP_SERVICE_UNAVAILABLE');
  }
  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // OTP_PEPPER is REQUIRED. Fail closed if not configured.
  let pepperOk = true;
  try {
    getOtpPepper();
  } catch {
    pepperOk = false;
  }
  if (!pepperOk) {
    await writeSecurityEvent(supabaseAdmin, {
      event_type: 'otp.send.misconfigured',
      severity: 'critical',
      action: 'send_otp',
      outcome: 'failure',
      payload: { reason: 'pepper_missing' },
    });
    return publicFailure('OTP_SERVICE_UNAVAILABLE');
  }

  // IP-level rate limit: 10 / minute / IP.
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  const ipLimit = await checkRateLimit(supabaseAdmin, clientIp, 'ip', 'send-otp', 10, 60, 0);
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
  const purpose = normalizeOtpPurpose(body?.purpose);
  if (!phone) {
    return json({ ok: false, error: 'PHONE_REQUIRED' }, 400);
  }

  let normalizedPhone: string;
  try {
    normalizedPhone = normalizePhone(phone);
  } catch {
    return json({ ok: false, error: 'INVALID_PHONE' }, 400);
  }

  const providerConfig = resolveAfricaTalkingConfig({
    apiKey: Deno.env.get('AT_API_KEY'),
    atEnv: Deno.env.get('AT_ENV'),
    username: Deno.env.get('AT_USERNAME'),
  });
  if (!providerConfig.ok) {
    logProviderDiagnostic('provider misconfigured', {
      at_env: providerConfig.atEnv,
      api_key_present: providerConfig.apiKeyPresent,
      phone_suffix: maskPhoneSuffix(normalizedPhone),
      reason: providerConfig.reason,
      username_present: providerConfig.usernamePresent,
    });
    return publicFailure(providerConfig.publicCode);
  }

  // Phone-level rate limit: 5 OTP requests / 10 mins; block 30 mins if exceeded.
  const phoneLimit = await checkRateLimit(
    supabaseAdmin, normalizedPhone, 'phone', 'send-otp', 5, 600, 1800,
  );
  if (!phoneLimit.allowed) {
    await writeSecurityEvent(supabaseAdmin, {
      event_type: 'otp.rate_limited',
      severity: 'warn',
      action: 'send_otp',
      outcome: 'denied',
      payload: { phone_hash: normalizedPhone.slice(-4), purpose, blocked: phoneLimit.blocked },
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

  // Generate the OTP, hash with pepper, persist BEFORE sending the SMS so a
  // crash mid-flow never leaves a code in the wild that we cannot verify.
  const otp = generateNumericOtp(6);
  let otpHash: string;
  try {
    otpHash = await hashOtpWithPepper(otp, normalizedPhone, purpose);
  } catch {
    return publicFailure('OTP_SERVICE_UNAVAILABLE');
  }
  const ttlMs = 5 * 60 * 1000;
  const nowMs = Date.now();
  const expiresAtIso = new Date(nowMs + ttlMs).toISOString();

  const { error: dbErr } = await supabaseAdmin.from('otp_records').insert({
    phone: normalizedPhone,
    otp_hash: otpHash,
    purpose,
    hash_version: OTP_HASH_VERSION,
    expiry: nowMs + ttlMs,           // legacy bigint column
    expires_at: expiresAtIso,        // canonical timestamptz
    attempts: 0,
  });
  if (dbErr) {
    console.error('[send-otp] otp insert failed', { db_code: dbErr.code ?? 'unknown' });
    return publicFailure('OTP_SERVICE_UNAVAILABLE');
  }

  // ── Send the SMS via Africa's Talking ──────────────────────────
  const smsBody = buildAfricaTalkingSmsBody({
    username: providerConfig.username,
    to: '+' + normalizedPhone,
    message: `Your Zuri Connect Africa code is ${otp}. Valid 5 mins. Never share this.`,
    from: Deno.env.get('AT_SENDER_ID'),
  });

  let providerStatus: number | null = null;
  let providerPublicCode: OtpProviderPublicCode | null = null;
  let providerErrorCode: string | null = null;
  let providerMalformed = false;
  const phoneSuffix = maskPhoneSuffix(normalizedPhone);
  try {
    const smsResponse = await fetch(providerConfig.url, {
      method: 'POST',
      headers: {
        apiKey: providerConfig.apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: smsBody.toString(),
    });
    providerStatus = smsResponse.status;
    const diagnostics = await readProviderDiagnostics(smsResponse);
    providerErrorCode = diagnostics.providerErrorCode;
    providerMalformed = diagnostics.providerMalformed;
    if (!smsResponse.ok) {
      providerPublicCode = mapProviderStatusToPublicCode(providerStatus);
    } else if (providerMalformed) {
      providerPublicCode = 'SMS_SEND_FAILED';
    } else if (!providerRecipientAccepted(providerErrorCode)) {
      providerPublicCode = 'SMS_PROVIDER_REJECTED';
    }
  } catch (fetchErr) {
    providerPublicCode = 'SMS_SEND_FAILED';
    logProviderDiagnostic('provider fetch failed', {
      at_env: providerConfig.atEnv,
      api_key_present: true,
      error_name: (fetchErr as Error)?.name ?? 'Error',
      phone_suffix: phoneSuffix,
      provider_status: providerStatus,
      username_present: true,
    });
  }

  if (providerPublicCode) {
    logProviderDiagnostic('provider send failed', {
      at_env: providerConfig.atEnv,
      api_key_present: true,
      phone_suffix: phoneSuffix,
      provider_error_code: providerErrorCode,
      provider_malformed: providerMalformed,
      provider_status: providerStatus,
      public_code: providerPublicCode,
      username_present: true,
    });

    // Best-effort: invalidate the just-issued OTP so an attacker who knows the
    // phone can't poll verify-otp and brute-force a code that was never sent.
    try {
      await supabaseAdmin
        .from('otp_records')
        .delete()
        .eq('phone', normalizedPhone)
        .eq('purpose', purpose)
        .is('consumed_at', null);
    } catch (rollbackErr) {
      console.error('[send-otp] otp rollback failed', {
        error_name: (rollbackErr as Error)?.name ?? 'Error',
        phone_suffix: phoneSuffix,
      });
    }

    await writeSecurityEvent(supabaseAdmin, {
      event_type: 'otp.send.failure',
      severity: 'warn',
      action: 'send_otp',
      outcome: 'failure',
      payload: {
        phone_suffix: phoneSuffix,
        purpose,
        provider_error_code: providerErrorCode,
        provider_malformed: providerMalformed,
        public_code: providerPublicCode,
        provider_status: providerStatus, // numeric status only — no body
      },
    });

    return publicFailure(providerPublicCode);
  }

  await writeSecurityEvent(supabaseAdmin, {
    event_type: 'otp.sent',
    severity: 'info',
    action: 'send_otp',
    outcome: 'success',
    payload: {
      phone_suffix: phoneSuffix,
      purpose,
      provider_error_code: providerErrorCode,
      provider_status: providerStatus,
      hash_version: OTP_HASH_VERSION,
      ttl_seconds: ttlMs / 1000,
    },
  });

  return json({ ok: true, success: true });
});
