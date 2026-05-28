import { invokeEdgeFunction } from '@/api/client.js';
import { generateTxRef } from '@/lib/ledger.js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { isClientDemoLedgerAllowed } from '@/lib/clientLedgerGuard.js';

const FINAL_SUCCESS = new Set(['succeeded']);
const FINAL_FAILURE = new Set(['failed', 'cancelled', 'canceled', 'timeout', 'timed_out']);
const FINAL_REVIEW = new Set(['review_required']);

export function paymentStatusMessage(status) {
  switch (String(status || '').toLowerCase()) {
    case 'processing':
      return 'Starting M-PESA STK Push...';
    case 'waiting_for_mpesa':
      return 'Waiting for M-PESA confirmation...';
    case 'step_up_required':
      return 'We need one more verification step.';
    case 'succeeded':
      return 'Payment succeeded';
    case 'failed':
      return 'Payment failed';
    case 'cancelled':
    case 'canceled':
      return 'Payment cancelled';
    case 'timeout':
    case 'timed_out':
      return 'M-PESA confirmation timed out';
    case 'review_required':
      return 'Payment requires review';
    case 'blocked':
      return 'For your safety, this action was blocked.';
    default:
      return status ? `Payment ${status}` : 'Waiting for M-PESA confirmation...';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAccessToken() {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) {
    throw new Error('AUTH_REQUIRED: Sign in again before initiating a payment.');
  }
  return data.session.access_token;
}

export async function initiateServerPayment({
  type = 'send',
  fromPhone,
  toPhone,
  amount,
  description = '',
  txRef,
  userId,
  idempotencyKey,
  metadata = {},
}) {
  const normalizedAmount = Number(amount);
  const transactionRef = txRef || generateTxRef(fromPhone);
  const key = idempotencyKey || `zuri_${type}_${transactionRef}_${userId || 'user'}`;

  if (isClientDemoLedgerAllowed()) {
    const { postTransaction } = await import('@/lib/ledger.js');
    const result = await postTransaction({
      fromPhone,
      toPhone,
      amount: normalizedAmount,
      description,
      txRef: transactionRef,
      owner: userId,
      idempotencyKey: key,
    });
    return {
      ok: true,
      demo: true,
      status: 'succeeded',
      tx_ref: result.txRef,
      pending_payment_id: null,
    };
  }

  const accessToken = await getAccessToken();
  const result = await invokeEdgeFunction('initiatePayment', {
    payment_type: type,
    tx_ref: transactionRef,
    idempotency_key: key,
    amount: normalizedAmount,
    from_phone: fromPhone,
    to_phone: toPhone,
    description,
    metadata,
  }, accessToken);

  if (!result?.ok) {
    if (result?.error === 'RISK_STEP_UP_REQUIRED') {
      return {
        ok: false,
        stepUpRequired: true,
        pending_payment_id: result.pending_payment_id,
        tx_ref: result.tx_ref || transactionRef,
        required_step_up: result.required_step_up || 'otp',
        step_up_challenge_id: result.step_up_challenge_id,
        message: 'We need one more verification step.',
        status: 'step_up_required',
      };
    }
    if (result?.error === 'RISK_MANUAL_REVIEW') {
      throw new Error('This payment needs review.');
    }
    if (result?.error === 'RISK_BLOCKED') {
      throw new Error('For your safety, this action was blocked.');
    }
    throw new Error(result?.message || result?.error || 'Payment initiation failed');
  }

  return {
    ...result,
    tx_ref: result.tx_ref || transactionRef,
    status: 'processing',
  };
}

export async function completeServerStepUp({
  pendingPaymentId,
  stepUpChallengeId,
  proof = {},
}) {
  const accessToken = await getAccessToken();
  let deviceFingerprintId;
  try {
    const { getCurrentDevice } = await import('@/lib/deviceTrust');
    deviceFingerprintId = getCurrentDevice()?.fingerprintId || undefined;
  } catch {
    deviceFingerprintId = undefined;
  }
  const result = await invokeEdgeFunction('completeStepUp', {
    pending_payment_id: pendingPaymentId,
    step_up_challenge_id: stepUpChallengeId,
    // Server-authoritative device deny-list check. Backward compatible — the
    // function only enforces when this value is present.
    device_fingerprint_id: deviceFingerprintId,
    ...proof,
  }, accessToken);

  if (!result?.ok) {
    throw new Error(result?.message || result?.error || 'Step-up verification failed');
  }

  return {
    ok: true,
    pending_payment_id: result.pending_payment_id || pendingPaymentId,
    tx_ref: result.tx_ref,
    status: result.status || 'waiting_for_mpesa',
  };
}

export async function getPendingPaymentStatus({ txRef, pendingPaymentId, checkoutRequestId }) {
  const supabase = getSupabaseBrowserClient();
  let query = supabase
    .from('pending_payments')
    .select('id, tx_ref, checkout_request_id, merchant_request_id, amount, status, result_code, result_desc, updated_at')
    .limit(1);

  if (pendingPaymentId) query = query.eq('id', pendingPaymentId);
  else if (txRef) query = query.eq('tx_ref', txRef);
  else if (checkoutRequestId) query = query.eq('checkout_request_id', checkoutRequestId);
  else throw new Error('PAYMENT_STATUS_INVALID: Missing payment identifier');

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message || 'Could not read payment status');
  if (!data) return null;
  return data;
}

export async function waitForPaymentConfirmation(
  payment,
  { intervalMs = 3000, timeoutMs = 90000, onStatus } = {}
) {
  if (payment?.demo) {
    onStatus?.({ status: 'succeeded', tx_ref: payment.tx_ref, demo: true });
    return { status: 'succeeded', tx_ref: payment.tx_ref, demo: true };
  }

  const started = Date.now();
  let lastStatus = payment?.status || 'processing';
  onStatus?.({ ...payment, status: lastStatus });

  while (Date.now() - started <= timeoutMs) {
    const row = await getPendingPaymentStatus({
      txRef: payment?.tx_ref,
      pendingPaymentId: payment?.pending_payment_id,
      checkoutRequestId: payment?.checkout_request_id,
    });

    if (row?.status) {
      lastStatus = row.status;
      onStatus?.(row);
      if (FINAL_SUCCESS.has(String(row.status).toLowerCase())) return row;
      if (FINAL_REVIEW.has(String(row.status).toLowerCase())) {
        throw new Error(row.result_desc || 'Payment requires reconciliation review before it can be completed.');
      }
      if (FINAL_FAILURE.has(String(row.status).toLowerCase())) {
        throw new Error(row.result_desc || `Payment ${row.status}`);
      }
    }

    await sleep(intervalMs);
  }

  throw new Error(`Payment confirmation timed out while status was ${lastStatus}.`);
}

export async function initiateAndWaitForPayment(params, options) {
  const payment = await initiateServerPayment(params);
  if (payment?.stepUpRequired) {
    const err = new Error(payment.message || 'We need one more verification step.');
    err.stepUp = payment;
    err.code = 'STEP_UP_REQUIRED';
    throw err;
  }
  return waitForPaymentConfirmation(payment, options);
}

/**
 * StepUpError is thrown by `initiateAndAwaitWithStepUp` when the server says a
 * payment needs an extra verification step. The error carries the step-up
 * context (challenge id, type, pending payment id) so a caller's UI can open
 * the appropriate modal.
 */
export class StepUpError extends Error {
  constructor(stepUp) {
    super(stepUp?.message || 'We need one more verification step.');
    this.name = 'StepUpError';
    this.code = 'STEP_UP_REQUIRED';
    this.stepUp = stepUp;
  }
}

/**
 * Map an `initiateServerPayment` step-up result + a user-supplied proof
 * (biometric assertion, OTP code, or PIN) into a completed payment row by
 * calling `completeServerStepUp` and polling for the final settlement state.
 *
 * All proofs (including biometric) are verified server-side. The frontend
 * never marks a step-up "verified" by itself — completeServerStepUp will throw
 * if the server rejects the assertion.
 */
export async function resumePaymentAfterStepUp(stepUp, proof, options = {}) {
  if (!stepUp?.pending_payment_id || !stepUp?.step_up_challenge_id) {
    throw new Error('Missing step-up context. Please retry the payment.');
  }
  const resumed = await completeServerStepUp({
    pendingPaymentId: stepUp.pending_payment_id,
    stepUpChallengeId: stepUp.step_up_challenge_id,
    proof: proof || {},
  });
  return waitForPaymentConfirmation(resumed, options);
}
