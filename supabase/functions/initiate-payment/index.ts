import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { requestDarajaStkPush } from '../_shared/daraja-stk.ts';
import { buildPendingPaymentRecord, normalizeMoneyAmount, normalizePhone } from '../_shared/payment-lifecycle.ts';
import { buildRiskEvaluationInput, evaluateRisk, publicRiskMessage } from '../_shared/risk-engine.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import { isClientDeviceRevoked } from '../_shared/device-trust.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';
if (!APP_ORIGIN) console.warn('[initiate-payment] APP_ORIGIN not set - CORS will be restrictive');

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

function pendingResponse(row: Record<string, unknown>, duplicate = false) {
  return {
    ok: true,
    duplicate,
    pending_payment_id: row.id,
    tx_ref: row.tx_ref,
    status: row.status || 'processing',
  };
}

async function persistRiskDecision(
  supabaseAdmin: any,
  pending: Record<string, unknown>,
  userId: string,
  result: ReturnType<typeof evaluateRisk>
) {
  const publicMessage = publicRiskMessage(result);
  const { error } = await supabaseAdmin.from('risk_decisions').insert({
    user_id: userId,
    pending_payment_id: pending.id,
    tx_ref: pending.tx_ref,
    decision: result.decision,
    risk_score: result.risk_score,
    reasons: result.reasons,
    required_step_up: result.required_step_up ?? null,
    public_message: publicMessage,
  });
  if (error) console.error('[initiate-payment] risk_decisions insert failed', error);
  return publicMessage;
}

async function writeSecurityEvent(
  supabaseAdmin: any,
  userId: string,
  event: Record<string, unknown>
) {
  const { error } = await supabaseAdmin.from('security_events').insert({
    user_id: userId,
    event_type: event.event_type || 'payment.risk_decision',
    severity: event.severity || 'info',
    action: event.action || 'evaluate_payment_risk',
    outcome: event.outcome || 'success',
    payload: event.payload || {},
  });
  if (error) console.error('[initiate-payment] security_events insert failed', error);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const envCheck = requireFunctionEnv({
    functionName: 'initiate-payment',
    required: [
      'APP_ORIGIN',
      'DARAJA_CONSUMER_KEY',
      'DARAJA_CONSUMER_SECRET',
      'DARAJA_SHORTCODE',
      'DARAJA_PASSKEY',
      'DARAJA_CALLBACK_URL',
      'DARAJA_ENV',
    ],
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

  if (!consumerKey || !consumerSecret || !shortcode || !passkey || !callbackUrl) {
    return json({
      ok: false,
      error: 'DARAJA_NOT_CONFIGURED',
      message: 'Add Daraja credentials and callback URL to Supabase Edge Function secrets.',
    }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  // Server-authoritative device trust deny-list. If the client sent a
  // fingerprint id and that device has been revoked from `trusted_devices`,
  // refuse to initiate the payment regardless of session validity. Clients
  // that do not send a fingerprint id are unaffected (backwards compatible).
  if (await isClientDeviceRevoked(supabaseAdmin, userRes.user.id, body.device_fingerprint_id)) {
    await supabaseAdmin.from('security_events').insert({
      user_id: userRes.user.id,
      event_type: 'payment.initiate.device_revoked',
      severity: 'critical',
      action: 'device_denied',
      outcome: 'denied',
      payload: { reason: 'revoked_device_fingerprint' },
    });
    return json({ ok: false, error: 'DEVICE_REVOKED' }, 403);
  }

  let normalizedFromPhone: string;
  try {
    normalizedFromPhone = normalizePhone(String(body.from_phone || ''));
    normalizeMoneyAmount(body.amount);
  } catch {
    return json({ ok: false, error: 'INVALID_PAYMENT_INPUT' }, 400);
  }

  const amount = Number(body.amount);
  if (amount <= 0 || amount > 150000) {
    return json({ ok: false, error: 'INVALID_AMOUNT', message: 'Amount must be between 1 and 150,000 KSh' }, 400);
  }

  const authPhone = userRes.user.phone ?? null;
  if (!authPhone) {
    return json({ ok: false, error: 'PROFILE_INCOMPLETE', message: 'Verify your phone number before initiating payments.' }, 403);
  }
  let profilePhone: string;
  try {
    profilePhone = normalizePhone(authPhone);
  } catch {
    return json({ ok: false, error: 'PROFILE_PHONE_INVALID' }, 403);
  }
  if (profilePhone !== normalizedFromPhone) {
    console.warn(`[initiate-payment] phone mismatch userId=${userRes.user.id}`);
    return json({ ok: false, error: 'PHONE_MISMATCH', message: 'Initiating phone does not match your verified account phone.' }, 403);
  }

  // ── Provider directory gate ─────────────────────────────────────
  // Only applies to paybill and till payments. send_money
  // (peer-to-peer phone-to-phone) is exempt because it's not a
  // directory lookup — it's a direct phone number transfer.

  const requireVerifiedProvider =
    Deno.env.get('ZURI_REQUIRE_VERIFIED_PROVIDER') === 'true';

  if (requireVerifiedProvider &&
      (body.payment_type === 'paybill' ||
       body.payment_type === 'till')) {

    // Use service_role for this lookup — we need to see the
    // verification status regardless of RLS. Risk decisions are
    // server-side, not user-side.
    const { data: methodRow, error: methodErr } = await supabaseAdmin
      .from('provider_payment_methods')
      .select('id, verification_status')
      .eq('method_type', body.payment_type)
      .eq('shortcode', body.to_phone)
      .maybeSingle();

    if (methodErr) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'initiate-payment',
        evt: 'provider_gate_lookup_failed',
        user_id: userRes.user.id,
        error_code: methodErr.code,
      }));
      return json({ error: 'provider_lookup_failed' }, 500);
    }

    if (!methodRow || methodRow.verification_status !== 'verified') {
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'initiate-payment',
        evt: 'unverified_provider_rejected',
        user_id: userRes.user.id,
        method_type: body.payment_type,
        shortcode: body.to_phone,
        actual_status: methodRow?.verification_status ?? 'not_in_directory',
      }));
      return json(
        {
          error: 'unverified_provider',
          message: 'This destination is not in our verified provider directory. ' +
                   'You can search verified billers via provider-search.',
        },
        422,
      );
    }
  }
  // ── End provider directory gate ─────────────────────────────────

  let pendingRecord;
  try {
    pendingRecord = buildPendingPaymentRecord({ body, userId: userRes.user.id, normalizedFromPhone });
  } catch (error) {
    console.warn('[initiate-payment] invalid payment payload', error instanceof Error ? error.message : 'INVALID_PAYLOAD');
    return json({ ok: false, error: 'INVALID_PAYMENT_INPUT' }, 400);
  }

  const windowStart = new Date(Date.now() - 3600_000).toISOString();
  const { count } = await supabaseAdmin
    .from('pending_payments')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userRes.user.id)
    .gte('created_at', windowStart);
  if ((count ?? 0) >= 5) {
    return json({ ok: false, error: 'RATE_LIMITED', message: 'Payment limit exceeded. Try again later.' }, 429);
  }

  const { data: existing } = await supabaseAdmin
    .from('pending_payments')
    .select('id, tx_ref, status')
    .eq('idempotency_key', pendingRecord.idempotency_key)
    .eq('user_id', userRes.user.id)
    .maybeSingle();
  if (existing) {
    return json(pendingResponse(existing, true));
  }

  const { data: pending, error: pendingErr } = await supabaseAdmin
    .from('pending_payments')
    .insert(pendingRecord)
    .select('id, tx_ref, status')
    .single();
  if (pendingErr) {
    if (pendingErr.code === '23505') {
      const { data: raced } = await supabaseAdmin
        .from('pending_payments')
        .select('id, tx_ref, status')
        .eq('idempotency_key', pendingRecord.idempotency_key)
        .eq('user_id', userRes.user.id)
        .maybeSingle();
      if (raced) return json(pendingResponse(raced, true));
    }
    console.error('[initiate-payment] pending payment create failed', { code: pendingErr.code });
    return json({ ok: false, error: 'PENDING_PAYMENT_CREATE_FAILED', message: 'We could not start this payment. Please try again.' }, 409);
  }

  let riskResult: ReturnType<typeof evaluateRisk>;
  let riskMessage = '';
  try {
    const riskInput = await buildRiskEvaluationInput({
      supabaseAdmin,
      pendingRecord: { ...pendingRecord, id: pending.id },
      user: userRes.user as unknown as Record<string, unknown>,
      body,
    });
    riskResult = evaluateRisk(riskInput);
    riskMessage = await persistRiskDecision(supabaseAdmin, pending, userRes.user.id, riskResult);
  } catch (error) {
    console.error('[initiate-payment] risk evaluation failed closed', error);
    riskResult = {
      decision: 'manual_review',
      risk_score: 100,
      reasons: ['risk_engine_error'],
      required_step_up: 'support_review',
    };
    riskMessage = await persistRiskDecision(supabaseAdmin, pending, userRes.user.id, riskResult);
  }

  if (riskResult.decision === 'step_up') {
    const challengeType = riskResult.required_step_up || 'otp';
    const { data: stepUpChallenge, error: stepUpErr } = await supabaseAdmin
      .from('step_up_challenges')
      .insert({
        user_id: userRes.user.id,
        pending_payment_id: pending.id,
        challenge_type: challengeType,
        status: 'pending',
      })
      .select('id')
      .single();
    if (stepUpErr || !stepUpChallenge) {
      return json({ ok: false, error: 'STEP_UP_CHALLENGE_CREATE_FAILED' }, 500);
    }
    await supabaseAdmin.from('pending_payments').update({
      status: 'step_up_required',
      result_code: 'RISK_STEP_UP_REQUIRED',
      result_desc: riskMessage,
      updated_at: new Date().toISOString(),
    }).eq('id', pending.id);
    await writeSecurityEvent(supabaseAdmin, userRes.user.id, {
      event_type: 'payment.step_up.created',
      severity: 'warn',
      action: 'hold_before_daraja',
      outcome: 'pending',
      payload: {
        pending_payment_id: pending.id,
        tx_ref: pending.tx_ref,
        required_step_up: challengeType,
        step_up_challenge_id: stepUpChallenge.id,
      },
    });
    return json({
      ok: false,
      error: 'RISK_STEP_UP_REQUIRED',
      status: 'step_up_required',
      pending_payment_id: pending.id,
      tx_ref: pending.tx_ref,
      required_step_up: challengeType,
      step_up_challenge_id: stepUpChallenge.id,
      message: riskMessage,
    }, 409);
  }

  if (riskResult.decision === 'manual_review') {
    await supabaseAdmin.from('pending_payments').update({
      status: 'review_required',
      result_code: 'RISK_MANUAL_REVIEW',
      result_desc: riskMessage,
      updated_at: new Date().toISOString(),
    }).eq('id', pending.id);
    await writeSecurityEvent(supabaseAdmin, userRes.user.id, {
      event_type: 'payment.risk.manual_review',
      severity: 'warn',
      action: 'hold_before_daraja',
      outcome: 'pending',
      payload: { pending_payment_id: pending.id, tx_ref: pending.tx_ref },
    });
    return json({
      ok: false,
      error: 'RISK_MANUAL_REVIEW',
      status: 'review_required',
      pending_payment_id: pending.id,
      tx_ref: pending.tx_ref,
      message: riskMessage,
    }, 409);
  }

  if (riskResult.decision === 'block') {
    await supabaseAdmin.from('pending_payments').update({
      status: 'failed',
      result_code: 'RISK_BLOCKED',
      result_desc: riskMessage,
      updated_at: new Date().toISOString(),
    }).eq('id', pending.id);
    await writeSecurityEvent(supabaseAdmin, userRes.user.id, {
      event_type: 'payment.risk.blocked',
      severity: 'critical',
      action: 'block_before_daraja',
      outcome: 'denied',
      payload: { pending_payment_id: pending.id, tx_ref: pending.tx_ref },
    });
    return json({
      ok: false,
      error: 'RISK_BLOCKED',
      status: 'blocked',
      pending_payment_id: pending.id,
      tx_ref: pending.tx_ref,
      message: riskMessage,
    }, 403);
  }

  try {
    const stk = await requestDarajaStkPush({
      darajaEnv,
      consumerKey,
      consumerSecret,
      shortcode,
      passkey,
      callbackUrl,
      amount: Number(pendingRecord.amount),
      fromPhone: normalizedFromPhone,
      accountReference: String((pendingRecord.metadata as Record<string, unknown>)?.account_reference || pendingRecord.tx_ref),
      transactionDesc: `ZuriConnect ${pendingRecord.tx_ref.slice(0, 8)}`,
    });

    if (!stk.ok) {
      await supabaseAdmin.from('pending_payments').update({
        status: 'failed',
        result_code: stk.responseCode,
        result_desc: stk.responseDescription,
        updated_at: new Date().toISOString(),
      }).eq('id', pending.id);
      return json({ ok: false, error: 'STK_PUSH_REJECTED', message: 'M-PESA could not start this request. Please confirm the details and try again.' }, 422);
    }

    await supabaseAdmin.from('pending_payments').update({
      checkout_request_id: stk.checkoutRequestId,
      merchant_request_id: stk.merchantRequestId,
      status: 'waiting_for_mpesa',
      updated_at: new Date().toISOString(),
    }).eq('id', pending.id);

    return json(pendingResponse({ id: pending.id, tx_ref: pendingRecord.tx_ref, status: 'processing' }));
  } catch (error) {
    await supabaseAdmin.from('pending_payments').update({
      status: 'failed',
      result_code: 'INITIATION_FAILED',
      result_desc: error instanceof Error ? error.message : 'Unknown initiation failure',
      updated_at: new Date().toISOString(),
    }).eq('id', pending.id);
    console.error('[initiate-payment]', error);
    return json({ ok: false, error: 'INITIATION_FAILED', message: 'Payment initiation is temporarily unavailable. Please try again.' }, 500);
  }
});
