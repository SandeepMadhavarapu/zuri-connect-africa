import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  getPinPepper,
  normalizePin,
  PIN_HASH_VERSION,
  storePepperPinHash,
  verifyPinWithPepper,
} from '../_shared/pin-crypto.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';
import { verifyOtpAgainstRecord } from '../_shared/step-up-verification.ts';
import { verifyWebAuthnAssertion } from '../_shared/webauthn-verify.ts';
import { normalizePhone } from '../_shared/payment-lifecycle.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type PinAction = 'setup' | 'change' | 'reset';

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

async function writeSecurityEvent(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  event: Record<string, unknown>
) {
  const { error } = await supabaseAdmin.from('security_events').insert({
    user_id: userId,
    event_type: event.event_type || 'pin.set',
    severity: event.severity || 'info',
    action: event.action || 'set_pin',
    outcome: event.outcome || 'success',
    payload: event.payload || {},
  });
  if (error) console.error('[set-pin] security_events insert failed', error);
}

async function loadExistingPin(supabaseAdmin: ReturnType<typeof createClient>, userId: string) {
  const { data } = await supabaseAdmin
    .from('pin_hash_metadata')
    .select('user_id, pin_hash, hash_version')
    .eq('user_id', userId)
    .maybeSingle();
  return data;
}

async function verifyOtpProof(
  supabaseAdmin: ReturnType<typeof createClient>,
  userPhone: string | null,
  body: Record<string, unknown>
): Promise<boolean> {
  const otp = String(body.otp ?? '').trim();
  if (!otp || !userPhone) return false;
  try {
    const phone = normalizePhone(userPhone);
    // PIN setup/change/reset OTPs are bound to the 'pin_setup' purpose so a
    // code minted for plain phone verification cannot be replayed to set/reset
    // the user's PIN.
    const result = await verifyOtpAgainstRecord(supabaseAdmin, phone, otp, 'pin_setup');
    return result.ok;
  } catch {
    return false;
  }
}

async function verifyBiometricProof(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  body: Record<string, unknown>,
  action: 'setup' | 'change' | 'reset'
): Promise<boolean> {
  // set-pin biometric proofs are unbound login-style assertions (no payment
  // step_up_challenge_id). The verifier still requires a valid challenge,
  // origin, RP ID, UP/UV flags, sign counter, and ECDSA-P256 signature. We do
  // NOT accept biometric proofs that were minted for a payment step-up — those
  // must complete via complete-step-up.
  const actionType = action === 'change' ? 'pin_change' : action === 'reset' ? 'pin_reset' : 'pin_setup';
  const result = await verifyWebAuthnAssertion(supabaseAdmin, userId, body, {
    expectedActionType: actionType,
  });
  return result.ok;
}

async function verifyCurrentPin(
  supabaseAdmin: ReturnType<typeof createClient>,
  userId: string,
  currentPin: unknown,
  existing: { pin_hash: string; hash_version: string | null }
): Promise<boolean> {
  const normalized = normalizePin(currentPin);
  if (!normalized) return false;
  try {
    const pepper = getPinPepper();
    return await verifyPinWithPepper(normalized, existing.pin_hash, pepper, existing.hash_version);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const envCheck = requireFunctionEnv({
    functionName: 'set-pin',
    required:       ['APP_ORIGIN', 'PIN_PEPPER'],
    optional:       ['OTP_PEPPER'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'MISSING_AUTHORIZATION' }, 401);

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userRes, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
  if (authErr || !userRes.user) return json({ ok: false, error: 'INVALID_TOKEN' }, 401);
  const userId = userRes.user.id;

  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  const ipLimit = await checkRateLimit(supabaseAdmin, clientIp, 'ip', 'set-pin', 20, 60, 0);
  if (!ipLimit.allowed) {
    return json({ ok: false, error: 'RATE_LIMITED', retryAfterSeconds: ipLimit.retryAfterSeconds }, 429);
  }

  const userLimit = await checkRateLimit(supabaseAdmin, userId, 'user', 'set-pin', 5, 3600, 1800);
  if (!userLimit.allowed) {
    return json({ ok: false, error: 'RATE_LIMITED', retryAfterSeconds: userLimit.retryAfterSeconds }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const action = String(body.action ?? 'setup').toLowerCase() as PinAction;
  if (!['setup', 'change', 'reset'].includes(action)) {
    return json({ ok: false, error: 'INVALID_ACTION' }, 400);
  }

  const pin = normalizePin(body.pin);
  if (!pin) {
    return json({ ok: false, error: 'INVALID_PIN_FORMAT', message: 'PIN must be exactly 6 digits.' }, 400);
  }

  let pepper: string;
  try {
    pepper = getPinPepper();
  } catch {
    return json({ ok: false, error: 'PIN_SERVICE_UNAVAILABLE' }, 503);
  }

  const existing = await loadExistingPin(supabaseAdmin, userId);
  const userPhone = userRes.user.phone ?? null;

  let proofOk = false;
  let proofType = 'unknown';

  if (action === 'setup') {
    if (existing?.pin_hash) {
      return json({ ok: false, error: 'PIN_ALREADY_SET' }, 409);
    }
    if (await verifyOtpProof(supabaseAdmin, userPhone, body)) {
      proofOk = true;
      proofType = 'otp';
    } else if (await verifyBiometricProof(supabaseAdmin, userId, body, 'setup')) {
      proofOk = true;
      proofType = 'biometric';
    }
    if (!proofOk) {
      await writeSecurityEvent(supabaseAdmin, userId, {
        event_type: 'pin.setup.denied',
        severity: 'warn',
        action: 'require_setup_proof',
        outcome: 'denied',
        payload: { reason: 'missing_proof' },
      });
      return json({
        ok: false,
        error: 'PROOF_REQUIRED',
        message: 'Verify with OTP or biometric (Face ID, Touch ID, Windows Hello) before creating a PIN.',
      }, 403);
    }
  }

  if (action === 'change') {
    if (!existing?.pin_hash) {
      return json({ ok: false, error: 'PIN_NOT_SET' }, 404);
    }
    if (await verifyCurrentPin(supabaseAdmin, userId, body.current_pin, existing)) {
      proofOk = true;
      proofType = 'current_pin';
    } else if (await verifyOtpProof(supabaseAdmin, userPhone, body)) {
      proofOk = true;
      proofType = 'otp';
    } else if (await verifyBiometricProof(supabaseAdmin, userId, body, 'change')) {
      proofOk = true;
      proofType = 'biometric';
    }
    if (!proofOk) {
      await writeSecurityEvent(supabaseAdmin, userId, {
        event_type: 'pin.change.denied',
        severity: 'warn',
        action: 'verify_change_proof',
        outcome: 'denied',
        payload: { reason: 'invalid_current_pin_or_proof' },
      });
      return json({
        ok: false,
        error: 'PROOF_REQUIRED',
        message: 'Current PIN or a fresh OTP/biometric verification is required to change your PIN.',
      }, 403);
    }
  }

  if (action === 'reset') {
    if (!existing?.pin_hash) {
      return json({ ok: false, error: 'PIN_NOT_SET' }, 404);
    }
    if (await verifyOtpProof(supabaseAdmin, userPhone, body)) {
      proofOk = true;
      proofType = 'otp';
    } else if (await verifyBiometricProof(supabaseAdmin, userId, body, 'reset')) {
      proofOk = true;
      proofType = 'biometric';
    }
    if (!proofOk) {
      await writeSecurityEvent(supabaseAdmin, userId, {
        event_type: 'pin.reset.denied',
        severity: 'warn',
        action: 'require_reset_proof',
        outcome: 'denied',
        payload: { reason: 'missing_otp_or_biometric' },
      });
      return json({
        ok: false,
        error: 'PROOF_REQUIRED',
        message: 'OTP or biometric verification is required to reset your PIN.',
      }, 403);
    }
  }

  const pinHash = await storePepperPinHash(pin, pepper);
  const { error: upsertErr } = await supabaseAdmin.from('pin_hash_metadata').upsert({
    user_id: userId,
    pin_hash: pinHash,
    hash_version: PIN_HASH_VERSION,
    upgraded_at: new Date().toISOString(),
  });

  if (upsertErr) {
    console.error('[set-pin] upsert failed', upsertErr.message);
    return json({ ok: false, error: 'PIN_STORE_FAILED' }, 500);
  }

  await writeSecurityEvent(supabaseAdmin, userId, {
    event_type: `pin.${action}.success`,
    severity: 'info',
    action: `pin_${action}`,
    outcome: 'success',
    payload: { proof_type: proofType, hash_version: PIN_HASH_VERSION },
  });

  return json({
    ok: true,
    action,
    pin_enrolled: true,
    hash_version: PIN_HASH_VERSION,
  });
});
