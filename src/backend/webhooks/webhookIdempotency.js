/**
 * Webhook idempotency and replay protection.
 * Tracks webhook IDs, transaction references, payload hashes, and state.
 */

const STORE_KEY = 'zuri_webhook_idempotency_v1';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export const WEBHOOK_STATE = {
  RECEIVED: 'received',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  DEAD: 'dead',
};

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{"webhooks":{},"txRefs":{},"payloadHashes":{}}');
  } catch {
    return { webhooks: {}, txRefs: {}, payloadHashes: {} };
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // Idempotency must be server-backed in production; demo storage is best-effort.
  }
}

function nowIso() {
  return new Date().toISOString();
}

function sweep(store) {
  const cutoff = Date.now() - RETENTION_MS;
  Object.keys(store.webhooks).forEach(webhookId => {
    if ((store.webhooks[webhookId].lastSeenAt || 0) < cutoff) delete store.webhooks[webhookId];
  });
  Object.keys(store.payloadHashes).forEach(hash => {
    if ((store.payloadHashes[hash].lastSeenAt || 0) < cutoff) delete store.payloadHashes[hash];
  });
}

export function deriveWebhookId(payload, payloadHash) {
  return payload?.Body?.stkCallback?.CheckoutRequestID ||
    payload?.Body?.stkCallback?.MerchantRequestID ||
    payload?.TransID ||
    payload?.TransactionID ||
    payload?.OriginatorConversationID ||
    payload?.ConversationID ||
    payload?.Result?.ConversationID ||
    payload?.Result?.OriginatorConversationID ||
    payload?.reference ||
    payload?.txRef ||
    payloadHash;
}

export function deriveTransactionRef(payload, fallback) {
  const stk = payload?.Body?.stkCallback;
  const metadata = stk?.CallbackMetadata?.Item || [];
  const receipt = metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;

  return payload?.txRef ||
    payload?.transactionRef ||
    payload?.BillRefNumber ||
    payload?.TransID ||
    receipt ||
    stk?.CheckoutRequestID ||
    payload?.Result?.TransactionID ||
    payload?.Result?.ConversationID ||
    fallback;
}

export function checkWebhookIdempotency({ webhookId, txRef, payloadHash }) {
  const store = readStore();
  sweep(store);

  const existingWebhook = webhookId ? store.webhooks[webhookId] : null;
  const existingPayload = payloadHash ? store.payloadHashes[payloadHash] : null;
  const existingTxRef = txRef ? store.txRefs[txRef] : null;
  const existing = existingWebhook || existingPayload || existingTxRef;

  if (!existing) {
    writeStore(store);
    return { duplicate: false, replay: false };
  }

  return {
    duplicate: true,
    replay: existing.payloadHash === payloadHash || existing.webhookId === webhookId,
    state: existing.state,
    previousResult: existing.result || null,
    record: existing,
  };
}

export function acquireWebhookLock({ webhookId, txRef, payloadHash, correlationId }) {
  const store = readStore();
  sweep(store);

  const duplicate = checkWebhookIdempotency({ webhookId, txRef, payloadHash });
  if (duplicate.duplicate) return duplicate;

  const record = {
    webhookId,
    txRef,
    payloadHash,
    correlationId,
    state: WEBHOOK_STATE.RECEIVED,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    firstSeenIso: nowIso(),
    updatedIso: nowIso(),
    attemptCount: 0,
    result: null,
  };

  if (webhookId) store.webhooks[webhookId] = record;
  if (txRef) store.txRefs[txRef] = record;
  if (payloadHash) store.payloadHashes[payloadHash] = record;

  writeStore(store);
  return { duplicate: false, replay: false, record };
}

export function updateWebhookState({ webhookId, txRef, payloadHash, state, result, error, jobId }) {
  const store = readStore();
  const record = (webhookId && store.webhooks[webhookId]) ||
    (payloadHash && store.payloadHashes[payloadHash]) ||
    (txRef && store.txRefs[txRef]);

  if (!record) return null;

  const next = {
    ...record,
    state,
    result: result ?? record.result,
    error: error || null,
    jobId: jobId || record.jobId || null,
    attemptCount: state === WEBHOOK_STATE.PROCESSING ? record.attemptCount + 1 : record.attemptCount,
    lastSeenAt: Date.now(),
    updatedIso: nowIso(),
  };

  if (next.webhookId) store.webhooks[next.webhookId] = next;
  if (next.txRef) store.txRefs[next.txRef] = next;
  if (next.payloadHash) store.payloadHashes[next.payloadHash] = next;

  writeStore(store);
  return next;
}

export function getWebhookIdempotencyRecord(key) {
  const store = readStore();
  return store.webhooks[key] || store.txRefs[key] || store.payloadHashes[key] || null;
}

export function listWebhookIdempotencyRecords() {
  return Object.values(readStore().webhooks);
}
