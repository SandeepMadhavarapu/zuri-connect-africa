import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { requestDarajaStkPush } from '../_shared/daraja-stk.ts';
import { normalizePhone } from '../_shared/payment-lifecycle.ts';
import {
  canResumePendingPayment,
  challengeMatchesPayment,
  isChallengeExpired,
  NON_RESUMABLE_PAYMENT_STATUSES,
  verifyOtpAgainstRecord,
  verifyUserPinForStepUp,
  verifyWebAuthnAssertion,
} from '../_shared/step-up-verification.ts';
import type { WebAuthnActionType } from '../_shared/webauthn-config.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import { isClientDeviceRevoked } from '../_shared/device-trust.ts';

const PAYMENT_TYPE_TO_ACTION_TYPE: Record<string, WebAuthnActionType> = {
  send: 'payment_send',
  paybill: 'payment_paybill',
  airtime: 'payment_airtime',
  bundle: 'payment_bundle',
};

function paymentActionTypeFor(pendingType: string | null | undefined): WebAuthnActionType {
  const normalized = String(pendingType || '').toLowerCase();
  return PAYMENT_TYPE_TO_ACTION_TYPE[normalized] || 'payment_send';
}

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

async function writeSecurityEvent(
  supabaseAdmin: any,
  userId: string,
  event: Record<string, unknown>
) {
  const { error } = await supabaseAdmin.from('security_events').insert({
    user_id: userId,
    event_type: event.event_type || 'payment.step_up',
    severity: event.severity || 'info',
    action: event.action || 'complete_step_up',
    outcome: event.outcome || 'success',
    payload: event.payload || {},
  });
  if (error) console.error('[complete-step-up] security_events insert failed', error);
}

async function verifyChallengeProof(
  supabaseAdmin: any,
  userId: string,
  userPhone: string | null,
  challengeType: string,
  body: Record<string, unknown>,
  binding: {
    stepUpChallengeId: string;
    pendingPaymentId: string;
    actionType: WebAuthnActionType;
    amountMinor: number;
    recipientSafe: string;
  },
  onPinFailure?: (reason: string) => Promise<void>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (challengeType === 'support_review') {
    return { ok: false, reason: 'support_review_required' };
  }

  if (challengeType === 'otp') {
    const otp = String(body.otp ?? '');
    if (!otp || !userPhone) return { ok: false, reason: 'otp_required' };
    let normalizedPhone: string;
    try {
      normalizedPhone = normalizePhone(userPhone);
    } catch {
      return { ok: false, reason: 'profile_phone_invalid' };
    }
    return verifyOtpAgainstRecord(supabaseAdmin, normalizedPhone, otp, 'step_up');
  }

  if (challengeType === 'pin') {
    if (!body.pin) return { ok: false, reason: 'pin_required' };
    return verifyUserPinForStepUp(supabaseAdmin, userId, body.pin, onPinFailure);
  }

  if (challengeType === 'biometric') {
    // Biometric proofs for payments MUST come from an action-bound WebAuthn
    // challenge minted via verify-biometric get_step_up_assertion_options. The
    // verifier re-derives the binding hash from this payment and refuses to
    // consume a challenge issued for a different action/amount/recipient.
    return verifyWebAuthnAssertion(supabaseAdmin, userId, body, {
      expectedStepUpChallengeId: binding.stepUpChallengeId,
      expectedActionType: binding.actionType,
      expectedPendingPaymentId: binding.pendingPaymentId,
      expectedAmountMinor: binding.amountMinor,
      expectedRecipientSafe: binding.recipientSafe,
    });
  }

  return { ok: false, reason: 'unsupported_challenge_type' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const envCheck = requireFunctionEnv({
    functionName: 'complete-step-up',
    required:       ['APP_ORIGIN', 'PIN_PEPPER', 'OTP_PEPPER'],
    // Daraja secrets are only required to RESUME a payment — checked further
    // down where the resume branch actually executes.
    optional:       ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE', 'DARAJA_PASSKEY', 'DARAJA_CALLBACK_URL', 'DARAJA_ENV'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const consumerKey = Deno.env.get('DARAJA_CONSUMER_KEY') ?? '';
  const consumerSecret = Deno.env.get('DARAJA_CONSUMER_SECRET') ?? '';
  const shortcode = Deno.env.get('DARAJA_SHORTCODE') ?? '';
  const passkey = Deno.env.get('DARAJA_PASSKEY') ?? '';
  const callbackUrl = Deno.env.get('DARAJA_CALLBACK_URL') ?? '';
  const darajaEnv = Deno.env.get('DARAJA_ENV') ?? 'sandbox';

  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'MISSING_AUTHORIZATION' }, 401);

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userRes, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
  if (authErr || !userRes.user) return json({ ok: false, error: 'INVALID_TOKEN' }, 401);
  const userId = userRes.user.id;

  if (!consumerKey || !consumerSecret || !shortcode || !passkey || !callbackUrl) {
    return json({ ok: false, error: 'DARAJA_NOT_CONFIGURED' }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const pendingPaymentId = String(body.pending_payment_id ?? '').trim();
  const stepUpChallengeId = String(body.step_up_challenge_id ?? body.challenge_id ?? '').trim();
  if (!pendingPaymentId || !stepUpChallengeId) {
    return json({ ok: false, error: 'MISSING_PAYMENT_OR_CHALLENGE' }, 400);
  }

  // Server-authoritative device trust check. If the client sent a fingerprint
  // id AND that device is in the deny-list, refuse to resume — even if the
  // refresh token is still valid in Supabase Auth. Older clients that do not
  // send a fingerprint id are unaffected (backwards compatible).
  if (await isClientDeviceRevoked(supabaseAdmin, userId, body.device_fingerprint_id)) {
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.device_revoked',
      severity: 'critical',
      action: 'device_denied',
      outcome: 'denied',
      payload: { pending_payment_id: pendingPaymentId, step_up_challenge_id: stepUpChallengeId },
    });
    return json({ ok: false, error: 'DEVICE_REVOKED' }, 403);
  }

  const { data: pending, error: pendingErr } = await supabaseAdmin
    .from('pending_payments')
    .select('id, tx_ref, user_id, status, amount, from_phone, to_phone, payment_type, description, idempotency_key, metadata, correlation_ref')
    .eq('id', pendingPaymentId)
    .eq('user_id', userId)
    .maybeSingle();

  if (pendingErr || !pending) {
    return json({ ok: false, error: 'PENDING_PAYMENT_NOT_FOUND' }, 404);
  }

  if (!canResumePendingPayment(pending.status)) {
    if (NON_RESUMABLE_PAYMENT_STATUSES.has(String(pending.status).toLowerCase())) {
      await writeSecurityEvent(supabaseAdmin, userId, {
        event_type: 'payment.step_up.resume_denied',
        severity: 'warn',
        action: 'resume_blocked_terminal_status',
        outcome: 'denied',
        payload: { pending_payment_id: pending.id, tx_ref: pending.tx_ref, status: pending.status },
      });
    }
    return json({ ok: false, error: 'PAYMENT_NOT_RESUMABLE', status: pending.status }, 409);
  }

  const { data: challenge, error: challengeErr } = await supabaseAdmin
    .from('step_up_challenges')
    .select('id, user_id, pending_payment_id, challenge_type, status, expires_at')
    .eq('id', stepUpChallengeId)
    .maybeSingle();

  if (challengeErr || !challenge) {
    return json({ ok: false, error: 'CHALLENGE_NOT_FOUND' }, 404);
  }

  if (challenge.user_id !== userId) {
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.wrong_user',
      severity: 'critical',
      action: 'challenge_user_mismatch',
      outcome: 'denied',
      payload: { pending_payment_id: pending.id, step_up_challenge_id: challenge.id },
    });
    return json({ ok: false, error: 'CHALLENGE_FORBIDDEN' }, 403);
  }

  if (challenge.pending_payment_id !== pending.id) {
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.payment_mismatch',
      severity: 'critical',
      action: 'challenge_payment_mismatch',
      outcome: 'denied',
      payload: { pending_payment_id: pending.id, step_up_challenge_id: challenge.id },
    });
    return json({ ok: false, error: 'CHALLENGE_PAYMENT_MISMATCH' }, 403);
  }

  if (!challengeMatchesPayment(challenge, pending, body)) {
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.amount_recipient_mismatch',
      severity: 'critical',
      action: 'challenge_binding_mismatch',
      outcome: 'denied',
      payload: { pending_payment_id: pending.id, step_up_challenge_id: challenge.id },
    });
    return json({ ok: false, error: 'CHALLENGE_BINDING_MISMATCH' }, 403);
  }

  if (challenge.status === 'verified') {
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.reused',
      severity: 'warn',
      action: 'challenge_reuse_attempt',
      outcome: 'denied',
      payload: { pending_payment_id: pending.id, step_up_challenge_id: challenge.id },
    });
    return json({ ok: false, error: 'CHALLENGE_ALREADY_USED' }, 409);
  }

  if (challenge.status !== 'pending' || isChallengeExpired(challenge.expires_at)) {
    if (challenge.status === 'pending') {
      await supabaseAdmin.from('step_up_challenges').update({ status: 'expired' }).eq('id', challenge.id);
    }
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.expired',
      severity: 'warn',
      action: 'challenge_expired',
      outcome: 'denied',
      payload: { pending_payment_id: pending.id, step_up_challenge_id: challenge.id },
    });
    return json({ ok: false, error: 'CHALLENGE_EXPIRED' }, 410);
  }

  const binding = {
    stepUpChallengeId: challenge.id,
    pendingPaymentId: pending.id,
    actionType: paymentActionTypeFor(pending.payment_type),
    amountMinor: Math.round(Number(pending.amount) * 100),
    recipientSafe: String(pending.to_phone || ''),
  };

  const proof = await verifyChallengeProof(
    supabaseAdmin,
    userId,
    userRes.user.phone ?? null,
    challenge.challenge_type,
    body,
    binding,
    async (reason) => {
      await writeSecurityEvent(supabaseAdmin, userId, {
        event_type: 'payment.step_up.pin_failed',
        severity: 'warn',
        action: 'verify_pin_proof',
        outcome: 'failure',
        payload: {
          pending_payment_id: pending.id,
          step_up_challenge_id: challenge.id,
          reason,
        },
      });
    }
  );

  if (!proof.ok) {
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.failed',
      severity: 'warn',
      action: 'verify_challenge_proof',
      outcome: 'failure',
      payload: {
        pending_payment_id: pending.id,
        step_up_challenge_id: challenge.id,
        challenge_type: challenge.challenge_type,
        reason: proof.reason,
      },
    });
    return json({ ok: false, error: 'STEP_UP_VERIFICATION_FAILED', message: 'Verification failed. Try again.' }, 403);
  }

  const nowIso = new Date().toISOString();
  const { data: verifiedChallenge, error: verifyUpdateErr } = await supabaseAdmin
    .from('step_up_challenges')
    .update({ status: 'verified', verified_at: nowIso })
    .eq('id', challenge.id)
    .eq('user_id', userId)
    .eq('pending_payment_id', pending.id)
    .eq('status', 'pending')
    .gt('expires_at', nowIso)
    .select('id')
    .maybeSingle();

  if (verifyUpdateErr || !verifiedChallenge) {
    await writeSecurityEvent(supabaseAdmin, userId, {
      event_type: 'payment.step_up.reused',
      severity: 'warn',
      action: 'challenge_race_or_reuse',
      outcome: 'denied',
      payload: { pending_payment_id: pending.id, step_up_challenge_id: challenge.id },
    });
    return json({ ok: false, error: 'CHALLENGE_ALREADY_USED' }, 409);
  }

  await writeSecurityEvent(supabaseAdmin, userId, {
    event_type: 'payment.step_up.verified',
    severity: 'info',
    action: 'verify_challenge_proof',
    outcome: 'success',
    payload: {
      pending_payment_id: pending.id,
      tx_ref: pending.tx_ref,
      step_up_challenge_id: challenge.id,
      challenge_type: challenge.challenge_type,
    },
  });

  const metadata = typeof pending.metadata === 'object' && pending.metadata !== null
    ? pending.metadata as Record<string, unknown>
    : {};
  // MED-3: prefer the server-generated correlation_ref (set at initiate-payment,
  // before the original STK call) so the resumed STK push echoes a key we can
  // re-link an orphaned callback on. Fall back for pre-migration rows.
  const accountReference = String(pending.correlation_ref || metadata.account_reference || pending.tx_ref);

  try {
    const stk = await requestDarajaStkPush({
      darajaEnv,
      consumerKey,
      consumerSecret,
      shortcode,
      passkey,
      callbackUrl,
      amount: Number(pending.amount),
      fromPhone: pending.from_phone,
      accountReference,
      transactionDesc: `ZuriConnect ${String(pending.tx_ref).slice(0, 8)}`,
    });

    if (!stk.ok) {
      await supabaseAdmin.from('pending_payments').update({
        status: 'failed',
        result_code: stk.responseCode,
        result_desc: stk.responseDescription,
        updated_at: nowIso,
      }).eq('id', pending.id);
      return json({ ok: false, error: 'STK_PUSH_REJECTED', message: 'M-PESA could not start this request. Please confirm the details and try again.' }, 422);
    }

    await supabaseAdmin.from('pending_payments').update({
      checkout_request_id: stk.checkoutRequestId,
      merchant_request_id: stk.merchantRequestId,
      status: 'waiting_for_mpesa',
      result_code: null,
      result_desc: null,
      updated_at: nowIso,
    }).eq('id', pending.id);

    return json({
      ok: true,
      pending_payment_id: pending.id,
      tx_ref: pending.tx_ref,
      status: 'waiting_for_mpesa',
    });
  } catch (error) {
    await supabaseAdmin.from('pending_payments').update({
      status: 'failed',
      result_code: 'INITIATION_FAILED',
      result_desc: error instanceof Error ? error.message : 'Unknown initiation failure',
      updated_at: nowIso,
    }).eq('id', pending.id);
    console.error('[complete-step-up]', error);
    return json({ ok: false, error: 'INITIATION_FAILED' }, 500);
  }
});
