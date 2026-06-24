import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { requestDarajaStkPush } from '../_shared/daraja-stk.ts';
import { normalizePhone, generateCorrelationRef } from '../_shared/payment-lifecycle.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';
if (!APP_ORIGIN) console.warn('[chama-contribute] APP_ORIGIN not set - CORS will be restrictive');

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

// Terminal failure statuses: an obligation whose linked pending_payment reached
// one of these states can be retried once the reconciliation-job sweep has reset
// the obligation back to 'due'. The stable idempotency key check uses this set.
const TERMINAL_FAILURE_STATUSES = new Set(['failed', 'cancelled', 'timeout']);

Deno.serve(async (req) => {
  // ── 1. CORS + method guard ──────────────────────────────────────────────
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const envCheck = requireFunctionEnv({
    functionName: 'chama-contribute',
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

  const supabaseUrl    = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey     = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const consumerKey    = Deno.env.get('DARAJA_CONSUMER_KEY') ?? '';
  const consumerSecret = Deno.env.get('DARAJA_CONSUMER_SECRET') ?? '';
  const shortcode      = Deno.env.get('DARAJA_SHORTCODE') ?? '';
  const passkey        = Deno.env.get('DARAJA_PASSKEY') ?? '';
  const callbackUrl    = Deno.env.get('DARAJA_CALLBACK_URL') ?? '';
  const darajaEnv      = Deno.env.get('DARAJA_ENV') ?? 'sandbox';

  // ── 3. JWT auth ─────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return json({ ok: false, error: 'MISSING_AUTHORIZATION' }, 401);

  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userRes, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
  if (authErr || !userRes.user) return json({ ok: false, error: 'INVALID_TOKEN' }, 401);

  const authUserId = userRes.user.id;

  // ── 2. Parse body ───────────────────────────────────────────────────────
  // body.amount is intentionally ignored — amount is server-derived from
  // chama_obligations.amount_due_cents. Accepting it would violate the rule
  // that client-supplied amounts are always recomputed server-side (CLAUDE.md).
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'INVALID_JSON' }, 400);
  }

  const obligationId = String(body.obligation_id || '').trim();
  const fromPhoneRaw = String(body.from_phone || '').trim();
  // body.idempotency_key from the caller is not stored. The pending_payments row
  // always uses the server-stable 'chama_contrib_{obligation_id}' key so the
  // one-in-flight invariant is enforced regardless of what the client sends.

  if (!obligationId) return json({ ok: false, error: 'OBLIGATION_ID_REQUIRED' }, 400);
  if (!fromPhoneRaw) return json({ ok: false, error: 'FROM_PHONE_REQUIRED' }, 400);

  // ── 4. Single JOIN query ─────────────────────────────────────────────────
  // Loads obligation + cycle + group + member in one round trip via PostgREST
  // resource embedding. FK hints ('!column') disambiguate which FK to follow.
  const { data: ob, error: obErr } = await supabaseAdmin
    .from('chama_obligations')
    .select(`
      id,
      status,
      payment_tx_ref,
      amount_due_cents,
      group_id,
      cycle_id,
      member_id,
      chama_contribution_cycles!cycle_id ( status, amount_cents ),
      chama_groups!group_id ( status, name ),
      chama_members!member_id ( id, status, user_id )
    `)
    .eq('id', obligationId)
    .maybeSingle();

  if (obErr) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'chama-contribute',
      evt: 'obligation_lookup_failed',
      user_id: authUserId,
      error_code: obErr.code,
    }));
    return json({ ok: false, error: 'INTERNAL_ERROR' }, 500);
  }

  // ── 5. Guard rails ───────────────────────────────────────────────────────

  // Obligation not found in DB.
  if (!ob) {
    return json({ ok: false, error: 'OBLIGATION_NOT_FOUND' }, 404);
  }

  const cycle  = ob.chama_contribution_cycles as { status: string; amount_cents: number } | null;
  const group  = ob.chama_groups as { status: string; name: string } | null;
  const member = ob.chama_members as { id: string; status: string; user_id: string } | null;

  // Obligation belongs to a different user. Return OBLIGATION_NOT_FOUND so we do
  // not leak that this obligation exists for someone else.
  if (!member || member.user_id !== authUserId) {
    return json({ ok: false, error: 'OBLIGATION_NOT_FOUND' }, 404);
  }

  if (member.status !== 'active') {
    return json({ ok: false, error: 'MEMBER_NOT_ACTIVE' }, 403);
  }

  if (!group || group.status !== 'active') {
    return json({ ok: false, error: 'GROUP_NOT_ACTIVE' }, 409);
  }

  if (!cycle || cycle.status !== 'open') {
    return json({ ok: false, error: 'CYCLE_NOT_OPEN' }, 409);
  }

  if (ob.status !== 'due') {
    return json({ ok: false, error: 'OBLIGATION_NOT_AVAILABLE' }, 409);
  }

  // ── 6. Phone gate ────────────────────────────────────────────────────────
  // Mirrors the gate in initiate-payment (lines 150-163): the from_phone in the
  // request must match the verified phone stored on the authenticated user record.
  const authPhone = userRes.user.phone ?? null;
  if (!authPhone) {
    return json({ ok: false, error: 'PROFILE_INCOMPLETE', message: 'Verify your phone number before initiating payments.' }, 403);
  }

  let normalizedFromPhone: string;
  let profilePhone: string;
  try {
    normalizedFromPhone = normalizePhone(fromPhoneRaw);
  } catch {
    return json({ ok: false, error: 'INVALID_PHONE' }, 400);
  }
  try {
    profilePhone = normalizePhone(authPhone);
  } catch {
    return json({ ok: false, error: 'PROFILE_PHONE_INVALID' }, 403);
  }

  if (profilePhone !== normalizedFromPhone) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'chama-contribute',
      evt: 'phone_mismatch',
      user_id: authUserId,
    }));
    return json({ ok: false, error: 'PHONE_MISMATCH', message: 'Initiating phone does not match your verified account phone.' }, 403);
  }

  // ── 7. Rate-limit check ──────────────────────────────────────────────────
  // Atomic, row-locking check via the shared check_rate_limit RPC (the same
  // mechanism the OTP/auth path uses) — replaces the old non-atomic read-then-act
  // COUNT, which a concurrent burst from one JWT could race past. Same policy as
  // before: 5 contributions per user per hour. The 'chama_contribute' endpoint is
  // a distinct bucket, keeping this limit independent of the other chama and auth
  // limits. checkRateLimit fails closed (denies) on RPC error.
  const rl = await checkRateLimit(supabaseAdmin, authUserId, 'user', 'chama_contribute', 5, 3600);
  if (!rl.allowed) {
    return json({ ok: false, error: 'RATE_LIMITED', retryAfterSeconds: rl.retryAfterSeconds }, 429);
  }

  // ── 8. Derive amount server-side ─────────────────────────────────────────
  // amount_due_cents is a BIGINT count of 1/100 KES. KES amounts are always
  // whole shillings, so division by 100 is exact with no float loss.
  const amountKes = Number(ob.amount_due_cents) / 100;
  const groupId   = ob.group_id as string;
  const memberId  = member.id;

  // ── 9. Idempotency ───────────────────────────────────────────────────────
  // Obligation-centric in-flight check: find the MOST RECENT pending_payments row
  // for this obligation (any idempotency key), ordered by created_at DESC.
  //
  // Why obligation-centric rather than stable-key lookup: a retry after failure
  // writes a disambiguated key ('chama_contrib_{id}_r{ts}'). Querying only the
  // stable key would miss that retry row, see the old failed row, conclude
  // "terminal-failed, allow another attempt", and fire a second STK push while
  // the retry is still in-flight. The obligation-centric query prevents this.
  //
  // Retry rule:
  //   - Most recent row NOT terminal-failed → in-flight or succeeded: return
  //     duplicate, do not fire another push.
  //   - Most recent row IS terminal-failed AND obligation is 'due' (confirmed by
  //     step-5 guard) → allow a new attempt with a fresh disambiguated key.
  //     The old failed row is preserved for the audit trail.
  //   - No row found → first attempt: use the stable key.
  const STABLE_KEY = `chama_contrib_${obligationId}`;

  const { data: existingPayment } = await supabaseAdmin
    .from('pending_payments')
    .select('id, tx_ref, status')
    .eq('user_id', authUserId)
    .eq('metadata->>obligation_id', obligationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let idempotencyKey = STABLE_KEY;

  if (existingPayment) {
    if (!TERMINAL_FAILURE_STATUSES.has(existingPayment.status)) {
      // In-flight or succeeded: idempotent return — do not fire a second STK push.
      return json({
        ok: true,
        duplicate: true,
        pending_payment_id: existingPayment.id,
        tx_ref: existingPayment.tx_ref,
      });
    }
    // Most recent attempt is terminal-failed and obligation is confirmed 'due' (step 5).
    // Use a fresh disambiguated key so the INSERT does not conflict with any prior row.
    idempotencyKey = `${STABLE_KEY}_r${Date.now()}`;
  }

  // ── 10. Build tx_ref ─────────────────────────────────────────────────────
  const txRef = `CC-${obligationId.slice(0, 8)}-${Date.now()}`;
  // MED-3: server-generated correlation key persisted on the row (below) BEFORE
  // the STK push and sent as AccountReference, so an orphaned chama callback is
  // re-linkable via correlation_ref even if checkout_request_id is never written.
  const correlationRef = generateCorrelationRef();

  // ── 11. Insert pending_payments ──────────────────────────────────────────
  // buildPendingPaymentRecord from payment-lifecycle cannot be used here: it
  // validates to_phone with /^[A-Z0-9_-]{3,32}$/i (rejects the 'CHAMA:<uuid>'
  // sentinel — colon character and length > 32 chars) and reads the amount from
  // the request body (throws INVALID_AMOUNT when absent). We build the record
  // inline with the same shape.
  const pendingRecord = {
    tx_ref:          txRef,
    user_id:         authUserId,
    idempotency_key: idempotencyKey,
    payment_type:    'chama_contribution',
    amount:          amountKes,
    from_phone:      normalizedFromPhone,
    to_phone:        `CHAMA:${groupId}`,
    description:     `Chama contribution ${groupId}`,
    correlation_ref: correlationRef,
    metadata: {
      obligation_id:       obligationId,
      group_id:            groupId,
      member_id:           memberId,
      credit_account_type: 'savings',
      account_reference:   txRef,
    },
    status:     'processing',
    updated_at: new Date().toISOString(),
  };

  const { data: pending, error: pendingErr } = await supabaseAdmin
    .from('pending_payments')
    .insert(pendingRecord)
    .select('id, tx_ref, status')
    .single();

  if (pendingErr) {
    if (pendingErr.code === '23505') {
      // Another concurrent request inserted with the same key just now.
      const { data: raced } = await supabaseAdmin
        .from('pending_payments')
        .select('id, tx_ref, status')
        .eq('idempotency_key', idempotencyKey)
        .eq('user_id', authUserId)
        .maybeSingle();
      if (raced) return json({ ok: true, duplicate: true, pending_payment_id: raced.id, tx_ref: raced.tx_ref });
    }
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'chama-contribute',
      evt: 'pending_payment_insert_failed',
      user_id: authUserId,
      error_code: pendingErr.code,
    }));
    return json({ ok: false, error: 'PENDING_PAYMENT_CREATE_FAILED' }, 409);
  }

  // ── 12. Optimistic UPDATE on obligation ──────────────────────────────────
  // Flip status to 'pending_payment' and stamp payment_tx_ref AFTER the
  // pending_payments INSERT succeeds but BEFORE firing the STK push.
  // The WHERE status='due' guard is the optimistic concurrency guard: if another
  // concurrent request already changed the status, rowCount will be 0 and we
  // detect the race. The chama_obligations_payment_tx_ref_uq unique index is the
  // hard backstop if two requests slip past the SELECT check simultaneously.
  const { data: updateResult, error: updateErr } = await supabaseAdmin
    .from('chama_obligations')
    .update({ status: 'pending_payment', payment_tx_ref: txRef, updated_at: new Date().toISOString() })
    .eq('id', obligationId)
    .eq('status', 'due')
    .select('id');

  if (updateErr || !updateResult || updateResult.length === 0) {
    // Race: another request changed the obligation status first. Delete the
    // orphaned pending row so it does not accumulate as a stuck payment.
    await supabaseAdmin.from('pending_payments').delete().eq('id', pending.id);
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'chama-contribute',
      evt: 'obligation_race_concurrency',
      user_id: authUserId,
      obligation_id: obligationId,
    }));
    return json({ ok: false, error: 'OBLIGATION_NOT_AVAILABLE', message: 'This obligation is no longer available. Please refresh and try again.' }, 409);
  }

  // ── 13. Fire STK push ────────────────────────────────────────────────────
  // requestDarajaStkPush throws on network-level failure (non-200 HTTP from
  // Daraja OAuth or STK endpoint). stk.ok = false means Daraja rejected the
  // request with a non-zero ResponseCode. Both paths must reset the obligation.
  try {
    const stk = await requestDarajaStkPush({
      darajaEnv,
      consumerKey,
      consumerSecret,
      shortcode,
      passkey,
      callbackUrl,
      amount:           amountKes,
      fromPhone:        normalizedFromPhone,
      accountReference: correlationRef,
      transactionDesc:  `ZuriChama ${txRef.slice(0, 8)}`,
    });

    if (!stk.ok) {
      // Daraja rejected the STK push (non-zero ResponseCode): mark payment failed
      // and reset the obligation so the member can retry.
      await supabaseAdmin.from('pending_payments').update({
        status:      'failed',
        result_code: stk.responseCode,
        result_desc: stk.responseDescription,
        updated_at:  new Date().toISOString(),
      }).eq('id', pending.id);

      // Guard on payment_tx_ref = txRef so we only reset the obligation that
      // this specific attempt stamped (never another concurrent attempt's obligation).
      await supabaseAdmin
        .from('chama_obligations')
        .update({ status: 'due', payment_tx_ref: null, updated_at: new Date().toISOString() })
        .eq('id', obligationId)
        .eq('payment_tx_ref', txRef);

      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        fn: 'chama-contribute',
        evt: 'stk_push_rejected',
        user_id: authUserId,
        obligation_id: obligationId,
        response_code: stk.responseCode,
      }));
      return json({ ok: false, error: 'STK_PUSH_FAILED', message: 'M-PESA could not start this request. Please try again.' }, 422);
    }

    // STK push accepted: update the pending row with Daraja's checkout identifiers.
    await supabaseAdmin.from('pending_payments').update({
      checkout_request_id: stk.checkoutRequestId,
      merchant_request_id: stk.merchantRequestId,
      status:              'waiting_for_mpesa',
      updated_at:          new Date().toISOString(),
    }).eq('id', pending.id);

    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'chama-contribute',
      evt: 'stk_push_accepted',
      user_id: authUserId,
      obligation_id: obligationId,
      pending_payment_id: pending.id,
    }));

    return json({ ok: true, pending_payment_id: pending.id, tx_ref: txRef });

  } catch (err) {
    // Network-level failure talking to Daraja (thrown by requestDarajaStkPush).
    // Mark the pending row failed and reset the obligation for retry.
    await supabaseAdmin.from('pending_payments').update({
      status:      'failed',
      result_code: 'DARAJA_NETWORK_ERROR',
      result_desc: err instanceof Error ? err.message : 'Unknown STK error',
      updated_at:  new Date().toISOString(),
    }).eq('id', pending.id);

    await supabaseAdmin
      .from('chama_obligations')
      .update({ status: 'due', payment_tx_ref: null, updated_at: new Date().toISOString() })
      .eq('id', obligationId)
      .eq('payment_tx_ref', txRef);

    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      fn: 'chama-contribute',
      evt: 'stk_push_network_error',
      user_id: authUserId,
      obligation_id: obligationId,
    }));
    return json({ ok: false, error: 'STK_PUSH_FAILED', message: 'Payment initiation is temporarily unavailable. Please try again.' }, 422);
  }
});
