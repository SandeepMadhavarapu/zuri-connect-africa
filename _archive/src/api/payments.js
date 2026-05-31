/**
 * Zuri Connect Africa — Payments API Layer
 * All payment flows go through here. Never call database tables directly from UI.
 */

import { obs, METRICS }    from '@/lib/observability';
import { emit, EVENTS }    from '@/lib/eventBus';
import { audit }           from '@/lib/auditLogger';
import { generateIdempotencyKey } from '@/lib/idempotency';
import { enqueueOfflineAction, detectConnectionQuality, CONNECTION_QUALITY } from '@/lib/offlineQueue';
import { recordFraudGraphEvent, updateFraudReputation } from '@/backend/fraud';
import { initiateServerPayment } from '@/services/paymentService.js';

const SENDER_PHONE = '+254700000000';

// ── Send Money ─────────────────────────────────────────────────────────────────

export async function sendMoney({ fromPhone, toPhone, amount, recipient, userId }) {
  const trace = obs.startTrace('payment.sendMoney');
  const iKey  = generateIdempotencyKey(fromPhone || SENDER_PHONE, 'transfer', amount);

  try {
    if (detectConnectionQuality() === CONNECTION_QUALITY.OFFLINE) {
      enqueueOfflineAction('send_money', { fromPhone, toPhone, amount, recipient, userId });
      obs.warn('sendMoney queued offline', { toPhone, amount });
      return { queued: true, offline: true };
    }

    obs.info('sendMoney initiated', { toPhone, amount, userId });

    const result = await initiateServerPayment({
      type:           'send',
      fromPhone:      fromPhone || SENDER_PHONE,
      toPhone:        toPhone   || recipient,
      amount,
      description:    `Send money to ${recipient || toPhone}`,
      idempotencyKey: iKey,
      userId,
    });

    updateFraudReputation({ recipient: toPhone || recipient, txRef: result.tx_ref, outcome: 'processing', amount });
    recordFraudGraphEvent({ txRef: result.tx_ref, phone: fromPhone || SENDER_PHONE, recipient: toPhone || recipient, amount, risk: 5, metadata: { type: 'send_money' } });
    emit(EVENTS.PAYMENT_CREATED, { txRef: result.tx_ref, amount, toPhone, userId, status: result.status });
    audit.paymentInitiated(userId, result.tx_ref, { type: 'send_money', amount, toPhone });

    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('sendMoney failed', { error: err.message, amount, toPhone });
    obs.track(METRICS.SETTLEMENT_FAILURE, 1, { type: 'send_money' });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

// ── Buy Airtime ───────────────────────────────────────────────────────────────

export async function buyAirtime({ fromPhone, toPhone, amount, userId }) {
  const trace = obs.startTrace('payment.buyAirtime');
  const iKey  = generateIdempotencyKey(fromPhone || SENDER_PHONE, 'airtime', amount);

  try {
    if (detectConnectionQuality() === CONNECTION_QUALITY.OFFLINE) {
      enqueueOfflineAction('buy_airtime', { fromPhone, toPhone, amount, userId });
      return { queued: true, offline: true };
    }

    obs.info('buyAirtime initiated', { toPhone, amount, userId });

    const result = await initiateServerPayment({
      type:           'airtime',
      fromPhone:      fromPhone || SENDER_PHONE,
      toPhone:        'AIRTIME_PROVIDER',
      amount,
      description:    `Airtime top-up ${toPhone}`,
      idempotencyKey: iKey,
      userId,
    });

    updateFraudReputation({ merchant: 'AIRTIME_PROVIDER', txRef: result.tx_ref, outcome: 'processing', amount });
    recordFraudGraphEvent({ txRef: result.tx_ref, phone: fromPhone || SENDER_PHONE, merchant: 'AIRTIME_PROVIDER', amount, risk: 3, metadata: { type: 'airtime' } });
    emit(EVENTS.PAYMENT_CREATED, { txRef: result.tx_ref, amount, toPhone, type: 'airtime', status: result.status });
    audit.paymentInitiated(userId, result.tx_ref, { type: 'airtime', amount, toPhone });

    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('buyAirtime failed', { error: err.message, amount });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

// ── Buy Bundle ────────────────────────────────────────────────────────────────

export async function buyBundle({ fromPhone, toPhone, amount, bundleName, userId }) {
  const trace = obs.startTrace('payment.buyBundle');
  const iKey  = generateIdempotencyKey(fromPhone || SENDER_PHONE, 'bundle', amount);

  try {
    if (detectConnectionQuality() === CONNECTION_QUALITY.OFFLINE) {
      enqueueOfflineAction('buy_bundle', { fromPhone, toPhone, amount, bundleName, userId });
      return { queued: true, offline: true };
    }

    obs.info('buyBundle initiated', { bundleName, amount, userId });

    const result = await initiateServerPayment({
      type:           'bundle',
      fromPhone:      fromPhone || SENDER_PHONE,
      toPhone:        'BUNDLE_PROVIDER',
      amount,
      description:    `Data bundle: ${bundleName}`,
      idempotencyKey: iKey,
      userId,
      metadata:       { bundle_name: bundleName },
    });

    updateFraudReputation({ merchant: 'BUNDLE_PROVIDER', txRef: result.tx_ref, outcome: 'processing', amount });
    recordFraudGraphEvent({ txRef: result.tx_ref, phone: fromPhone || SENDER_PHONE, merchant: 'BUNDLE_PROVIDER', amount, risk: 3, metadata: { type: 'bundle' } });
    emit(EVENTS.PAYMENT_CREATED, { txRef: result.tx_ref, amount, bundleName, type: 'bundle', status: result.status });
    audit.paymentInitiated(userId, result.tx_ref, { type: 'bundle', amount, bundleName });

    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('buyBundle failed', { error: err.message, bundleName });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

// ── Paybill ───────────────────────────────────────────────────────────────────

export async function paybill({ fromPhone, businessNumber, accountNumber, amount, billerName, userId }) {
  const trace = obs.startTrace('payment.paybill');
  const iKey  = generateIdempotencyKey(fromPhone || SENDER_PHONE, `paybill_${businessNumber}`, amount);

  try {
    if (detectConnectionQuality() === CONNECTION_QUALITY.OFFLINE) {
      enqueueOfflineAction('paybill', { fromPhone, businessNumber, accountNumber, amount, billerName, userId });
      return { queued: true, offline: true };
    }

    obs.info('paybill initiated', { businessNumber, amount, userId });

    const result = await initiateServerPayment({
      type:           'paybill',
      fromPhone:      fromPhone || SENDER_PHONE,
      toPhone:        businessNumber,
      amount,
      description:    `Paybill ${billerName || businessNumber} Acc:${accountNumber}`,
      idempotencyKey: iKey,
      userId,
      metadata:       { biller_name: billerName, account_number: accountNumber },
    });

    updateFraudReputation({ merchant: businessNumber, txRef: result.tx_ref, outcome: 'processing', amount });
    recordFraudGraphEvent({ txRef: result.tx_ref, phone: fromPhone || SENDER_PHONE, merchant: businessNumber, amount, risk: 6, metadata: { type: 'paybill', accountNumber } });
    emit(EVENTS.PAYMENT_CREATED, { txRef: result.tx_ref, amount, businessNumber, type: 'paybill', status: result.status });
    audit.paymentInitiated(userId, result.tx_ref, { type: 'paybill', amount, businessNumber, accountNumber });

    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('paybill failed', { error: err.message, businessNumber, amount });
    obs.endTrace(trace.traceId);
    throw err;
  }
}
