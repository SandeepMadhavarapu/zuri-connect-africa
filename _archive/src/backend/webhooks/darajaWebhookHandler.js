/**
 * Safaricom Daraja webhook ingress and async worker.
 * Supports STK Push, C2B, B2C, reversal, timeout, and failed settlement callbacks.
 */

import { emit } from '@/lib/eventBus';
import { obs } from '@/lib/observability';
import { reverseSettlement } from '@/lib/settlementEngine';
import { evaluateRisk } from '@/lib/riskEngine';
import { verifyDarajaWebhookRequest, getWebhookHeader } from './verifyWebhook';
import { logWebhookAudit } from './webhookAudit';
import { acquireWebhookLock, checkWebhookIdempotency, deriveTransactionRef, deriveWebhookId } from './webhookIdempotency';
import { enqueueWebhookJob, processWebhookQueue } from './webhookQueue';

const DEFAULT_ALLOWED_IPS = [];
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 120;
const rateLimitBuckets = new Map();

function generateCorrelationId() {
  return `corr_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function headerSourceIp(headers) {
  return getWebhookHeader(headers, 'x-forwarded-for')?.split(',')[0]?.trim() ||
    getWebhookHeader(headers, 'x-real-ip') ||
    'unknown';
}

function isIpAllowed(sourceIp, allowedIps = DEFAULT_ALLOWED_IPS) {
  if (!allowedIps || allowedIps.length === 0) return true;
  return allowedIps.includes(sourceIp);
}

function checkRateLimit(sourceIp) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(sourceIp) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateLimitBuckets.set(sourceIp, bucket);

  return {
    allowed: bucket.count <= RATE_LIMIT_MAX,
    count: bucket.count,
    resetAt: bucket.resetAt,
  };
}

function callbackMetadata(stkCallback) {
  const items = stkCallback?.CallbackMetadata?.Item || [];
  return Object.fromEntries(items.map(item => [item.Name, item.Value]));
}

function normaliseDarajaPayload(payload, payloadHash) {
  const stk = payload?.Body?.stkCallback;
  const result = payload?.Result;
  const metadata = callbackMetadata(stk);

  if (stk) {
    const success = Number(stk.ResultCode) === 0;
    return {
      type: 'stk_push',
      eventType: success ? 'payment.completed' : 'payment.failed',
      status: success ? 'success' : 'failed',
      txRef: metadata.MpesaReceiptNumber || stk.CheckoutRequestID,
      webhookId: stk.CheckoutRequestID || stk.MerchantRequestID || payloadHash,
      amount: Number(metadata.Amount || 0),
      fromPhone: metadata.PhoneNumber ? `+${metadata.PhoneNumber}` : null,
      toPhone: 'ZURI_SETTLEMENT_ACCOUNT',
      receiptNumber: metadata.MpesaReceiptNumber || null,
      resultCode: stk.ResultCode,
      resultDescription: stk.ResultDesc,
      occurredAt: metadata.TransactionDate || Date.now(),
    };
  }

  if (payload.TransID || payload.TransactionType) {
    return {
      type: 'c2b',
      eventType: 'payment.completed',
      status: 'success',
      txRef: payload.TransID,
      webhookId: payload.TransID || payloadHash,
      amount: Number(payload.TransAmount || 0),
      fromPhone: payload.MSISDN ? `+${payload.MSISDN}` : null,
      toPhone: payload.BusinessShortCode || 'ZURI_SETTLEMENT_ACCOUNT',
      receiptNumber: payload.TransID,
      resultDescription: payload.TransactionType || 'C2B callback',
      occurredAt: payload.TransTime || Date.now(),
    };
  }

  if (result) {
    const resultCode = Number(result.ResultCode);
    const type = String(result.ResultType || result.TransactionType || '').toLowerCase();
    const isReversal = type.includes('reversal') || String(result.ResultDesc || '').toLowerCase().includes('reversal');
    const isTimeout = resultCode === 1 || String(result.ResultDesc || '').toLowerCase().includes('timeout');

    return {
      type: isReversal ? 'reversal' : isTimeout ? 'timeout' : 'b2c',
      eventType: resultCode === 0 ? (isReversal ? 'payment.reversed' : 'settlement.updated') : 'settlement.failed',
      status: resultCode === 0 ? 'success' : 'failed',
      txRef: result.TransactionID || result.ConversationID || result.OriginatorConversationID || payloadHash,
      webhookId: result.ConversationID || result.OriginatorConversationID || payloadHash,
      amount: Number(result.TransactionAmount || result.Amount || 0),
      fromPhone: result.InitiatorAccountCurrentBalance ? 'ZURI_SETTLEMENT_ACCOUNT' : null,
      toPhone: result.ReceiverPartyPublicName || result.ReceiverParty || null,
      receiptNumber: result.TransactionID || null,
      resultCode,
      resultDescription: result.ResultDesc,
      occurredAt: Date.now(),
    };
  }

  return {
    type: 'unknown',
    eventType: 'webhook.received',
    status: 'received',
    txRef: deriveTransactionRef(payload, payloadHash),
    webhookId: deriveWebhookId(payload, payloadHash),
    amount: 0,
    fromPhone: null,
    toPhone: null,
    resultDescription: 'Unrecognised Daraja payload shape',
    occurredAt: Date.now(),
  };
}

function fastResponse(status, body) {
  return {
    status,
    body,
    headers: { 'content-type': 'application/json' },
  };
}

export async function handleDarajaWebhook({
  rawPayload,
  headers = {},
  sourceIp,
  secret,
  allowedIps = DEFAULT_ALLOWED_IPS,
  startWorker = true,
} = {}) {
  const correlationId = getWebhookHeader(headers, 'x-correlation-id') || generateCorrelationId();
  const ip = sourceIp || headerSourceIp(headers);
  const receivedAt = performance.now();

  emit('webhook.received', { correlationId, sourceIp: ip });
  logWebhookAudit('webhook.received', { correlationId, sourceIp: ip, queueStatus: 'received' });

  const rate = checkRateLimit(ip);
  if (!rate.allowed) {
    emit('webhook.rejected', { correlationId, sourceIp: ip, reason: 'rate_limited' });
    logWebhookAudit('webhook.rejected', { correlationId, sourceIp: ip, queueStatus: 'rejected', details: { reason: 'rate_limited' } });
    obs.track('webhook_replay_attack_attempts', 1, { reason: 'rate_limited' });
    return fastResponse(429, { ok: false, correlationId, error: 'rate_limited' });
  }

  if (!isIpAllowed(ip, allowedIps)) {
    emit('webhook.rejected', { correlationId, sourceIp: ip, reason: 'ip_not_allowed' });
    logWebhookAudit('webhook.rejected', { correlationId, sourceIp: ip, queueStatus: 'rejected', details: { reason: 'ip_not_allowed' } });
    return fastResponse(403, { ok: false, correlationId, error: 'ip_not_allowed' });
  }

  const verification = await verifyDarajaWebhookRequest({ rawPayload, headers, secret });
  if (!verification.valid) {
    emit('webhook.rejected', { correlationId, sourceIp: ip, reason: verification.reason });
    logWebhookAudit('webhook.rejected', {
      correlationId,
      sourceIp: ip,
      signatureValid: false,
      replayAttempt: verification.reason?.includes('stale') || verification.reason?.includes('timestamp'),
      queueStatus: 'rejected',
      details: verification,
    });
    obs.track(verification.reason === 'invalid_signature' ? 'webhook_signature_failures' : 'webhook_replay_attack_attempts', 1);
    return fastResponse(400, { ok: false, correlationId, error: verification.reason });
  }

  const normalizedEvent = normaliseDarajaPayload(verification.payload, verification.payloadHash);
  const webhookId = normalizedEvent.webhookId || deriveWebhookId(verification.payload, verification.payloadHash);
  const txRef = normalizedEvent.txRef || deriveTransactionRef(verification.payload, verification.payloadHash);

  const duplicate = checkWebhookIdempotency({ webhookId, txRef, payloadHash: verification.payloadHash });
  if (duplicate.duplicate) {
    emit('webhook.duplicate', { webhookId, txRef, correlationId, previousState: duplicate.state });
    logWebhookAudit('webhook.duplicate', {
      webhookId,
      txRef,
      correlationId,
      sourceIp: ip,
      signatureValid: true,
      replayAttempt: duplicate.replay,
      queueStatus: duplicate.state,
    });
    obs.track('webhook_duplicate_callback_count', 1);
    return fastResponse(200, {
      ok: true,
      duplicate: true,
      correlationId,
      previousResult: duplicate.previousResult,
    });
  }

  acquireWebhookLock({ webhookId, txRef, payloadHash: verification.payloadHash, correlationId });
  emit('webhook.verified', { webhookId, txRef, correlationId });
  logWebhookAudit('webhook.verified', {
    webhookId,
    txRef,
    correlationId,
    sourceIp: ip,
    signatureValid: true,
    queueStatus: 'verified',
  });

  const job = enqueueWebhookJob({
    webhookId,
    txRef,
    payloadHash: verification.payloadHash,
    payload: verification.payload,
    normalizedEvent,
    correlationId,
    sourceIp: ip,
  });

  if (startWorker) {
    setTimeout(() => processWebhookQueue(processDarajaWebhookJob), 0);
  }

  obs.track('webhook_ingress_latency_ms', Math.round(performance.now() - receivedAt));
  return fastResponse(200, { ok: true, accepted: true, correlationId, jobId: job.jobId });
}

export async function processDarajaWebhookJob(job) {
  const event = job.normalizedEvent || normaliseDarajaPayload(job.payload, job.payloadHash);
  const risk = evaluateRisk({
    amount: event.amount,
    recipient: event.toPhone || event.txRef,
    actionType: event.type,
    skipSimSwapCheck: true,
  });

  emit('webhook.processing', {
    webhookId: job.webhookId,
    txRef: job.txRef,
    correlationId: job.correlationId,
    risk,
  });

  if (event.status === 'failed' || event.type === 'timeout') {
    emit('settlement.failed', {
      txRef: event.txRef,
      webhookId: job.webhookId,
      correlationId: job.correlationId,
      reason: event.resultDescription || 'Daraja callback reported failure',
    });
    obs.track('webhook_callback_success_rate', 1, { status: 'failed' });
    return { success: true, status: 'failed', settlementOutcome: 'settlement.failed', risk };
  }

  if (event.type === 'reversal') {
    reverseSettlement(event.txRef, event.resultDescription || 'Daraja reversal callback');
    emit('settlement.updated', {
      txRef: event.txRef,
      webhookId: job.webhookId,
      correlationId: job.correlationId,
      status: 'reversed',
    });
    return { success: true, status: 'reversed', settlementOutcome: 'reversed', risk };
  }

  if (event.amount > 0 && event.fromPhone && event.toPhone) {
    logWebhookAudit('webhook.ledger_deferred', {
      webhookId: job.webhookId,
      txRef: event.txRef,
      correlationId: job.correlationId,
      queueStatus: 'deferred',
      details: {
        reason: 'ledger_posting_moved_to_supabase_edge_function',
      },
    });
  }

  emit('settlement.updated', {
    txRef: event.txRef,
    webhookId: job.webhookId,
    correlationId: job.correlationId,
    status: 'settled',
    receiptNumber: event.receiptNumber,
  });

  return { success: true, status: 'settled', settlementOutcome: 'settled', risk };
}

export function normalizeDarajaPayload(payload, payloadHash = 'payload') {
  return normaliseDarajaPayload(payload, payloadHash);
}
