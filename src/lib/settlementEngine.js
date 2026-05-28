/**
 * Zuri Connect Africa — Settlement Engine
 * Implements realistic settlement lifecycle:
 *   pending → processing → settled → failed → reversed → disputed
 *
 * Integrates with queue.js for async processing and ledger.js for reversal entries.
 */

import { invokeEdgeFunction } from '@/api/client.js';
import { enqueueJob, processQueue, QUEUES } from './queue';
import { generateReversalRef } from './ledger';
import { emit, EVENTS } from './eventBus';
import { obs, METRICS } from './observability';

const SETTLEMENT_KEY = 'zuri_settlements';

export const SETTLEMENT_STATUS = {
  PENDING:    'pending',
  PROCESSING: 'processing',
  SETTLED:    'settled',
  FAILED:     'failed',
  REVERSED:   'reversed',
  DISPUTED:   'disputed',
};

// ── Storage ───────────────────────────────────────────────────────────────────

function readSettlements() {
  try {
    return JSON.parse(sessionStorage.getItem(SETTLEMENT_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeSettlements(store) {
  sessionStorage.setItem(SETTLEMENT_KEY, JSON.stringify(store));
}

function createSettlementRecord(txRef, amount, fromPhone, toPhone, idempotencyKey) {
  return {
    txRef,
    amount,
    fromPhone,
    toPhone,
    idempotencyKey:   idempotencyKey || null,
    settlementStatus: SETTLEMENT_STATUS.PENDING,
    settledAt:        null,
    reversalRef:      null,
    failureReason:    null,
    disputeRef:       null,
    createdAt:        Date.now(),
    updatedAt:        Date.now(),
    retryCount:       0,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Queue a settlement for async processing.
 * Called immediately after double-entry ledger posting.
 */
export function queueSettlement(txRef, amount, fromPhone, toPhone, idempotencyKey) {
  const store = readSettlements();

  if (!store[txRef]) {
    store[txRef] = createSettlementRecord(txRef, amount, fromPhone, toPhone, idempotencyKey);
    writeSettlements(store);
  }

  const job = enqueueJob(QUEUES.SETTLEMENT, { txRef, amount, fromPhone, toPhone });
  console.info(`[Settlement] Queued — txRef: ${txRef}, jobId: ${job.jobId}`);
  return job;
}

/**
 * Process a single settlement job.
 * Simulates realistic clearing: ~300–700ms processing window.
 * In production this calls a payment rails API (e.g. Safaricom Daraja).
 */
export async function processSettlement(job) {
  const startedAt = performance.now();
  const { txRef, amount } = job.payload;
  const store = readSettlements();
  const record = store[txRef];

  if (!record) {
    return { success: false, error: `No settlement record for txRef ${txRef}` };
  }

  record.settlementStatus = SETTLEMENT_STATUS.PROCESSING;
  record.updatedAt        = Date.now();
  writeSettlements(store);

  // ── Real Daraja STK Push ──────────────────────────────────────────────────
  // Calls the initiate-payment edge function which handles OAuth + STK Push.
  // Settlement moves to PROCESSING — it becomes SETTLED only when Daraja
  // sends the callback to webhook-handler confirming the user's M-PESA PIN.
  // If Daraja is not configured, fails explicitly — never fakes success.
  let deviceFingerprintId;
  try {
    // Lazy require so the settlement engine still works in non-browser tests.
    // eslint-disable-next-line global-require
    const { getCurrentDevice } = await import('./deviceTrust');
    deviceFingerprintId = getCurrentDevice()?.fingerprintId || undefined;
  } catch {
    deviceFingerprintId = undefined;
  }

  let stkResult;
  try {
    stkResult = await invokeEdgeFunction('initiatePayment', {
      tx_ref:     txRef,
      amount,
      from_phone: job.payload.fromPhone,
      to_phone:   job.payload.toPhone,
      // Server-authoritative device deny-list check. Sent best-effort; the
      // backend treats missing values as backward-compatible.
      device_fingerprint_id: deviceFingerprintId,
    });
  } catch (edgeErr) {
    const reason = edgeErr?.message || 'Payment initiation failed — edge function unreachable';
    record.settlementStatus = SETTLEMENT_STATUS.FAILED;
    record.failureReason    = reason;
    record.retryCount++;
    record.updatedAt        = Date.now();
    writeSettlements(store);
    console.warn(`[Settlement] Edge function error — txRef: ${txRef}, error: ${reason}`);
    emitPaymentEvent('PAYMENT_FAILED', { txRef, amount, reason });
    emit(EVENTS.SETTLEMENT_FAILED, { txRef, amount, reason });
    obs.track(METRICS.SETTLEMENT_FAILURE, 1, { status: SETTLEMENT_STATUS.FAILED });
    return { success: false, error: reason };
  }

  if (!stkResult?.ok) {
    const reason = stkResult?.message || stkResult?.error || 'STK Push initiation failed';
    const notConfigured = stkResult?.error === 'DARAJA_NOT_CONFIGURED';
    record.settlementStatus = SETTLEMENT_STATUS.FAILED;
    record.failureReason    = reason;
    record.retryCount      += notConfigured ? 0 : 1;
    record.updatedAt        = Date.now();
    writeSettlements(store);
    console.warn(`[Settlement] STK Push failed — txRef: ${txRef}, reason: ${reason}`);
    emitPaymentEvent('PAYMENT_FAILED', { txRef, amount, reason });
    emit(EVENTS.SETTLEMENT_FAILED, { txRef, amount, reason });
    obs.track(METRICS.SETTLEMENT_FAILURE, 1, { status: SETTLEMENT_STATUS.FAILED });
    return { success: false, error: reason, notConfigured };
  }

  // STK Push sent — move to PROCESSING (awaiting Daraja callback)
  record.settlementStatus  = SETTLEMENT_STATUS.PROCESSING;
  record.checkoutRequestId = stkResult.checkout_request_id;
  record.merchantRequestId = stkResult.merchant_request_id;
  record.updatedAt         = Date.now();
  writeSettlements(store);

  console.info(`[Settlement] STK Push sent — txRef: ${txRef}, CheckoutRequestID: ${stkResult.checkout_request_id}`);
  emitPaymentEvent('PAYMENT_PROCESSING', { txRef, amount, checkoutRequestId: stkResult.checkout_request_id });
  emit(EVENTS.SETTLEMENT_UPDATED, { txRef, amount, status: SETTLEMENT_STATUS.PROCESSING });
  obs.track(METRICS.SETTLEMENT_LATENCY, Math.round(performance.now() - startedAt), { status: SETTLEMENT_STATUS.PROCESSING });
  return { success: true, processing: true, checkoutRequestId: stkResult.checkout_request_id, record };
}

/**
 * Run the settlement queue — process all pending settlements.
 * Non-blocking, safe to call on any user action.
 */
export async function runSettlementQueue() {
  return processQueue(QUEUES.SETTLEMENT, processSettlement);
}

/**
 * Retry all failed (non-dead) settlements.
 */
export async function retryFailedSettlements() {
  const store  = readSettlements();
  const failed = Object.values(store).filter(
    r => r.settlementStatus === SETTLEMENT_STATUS.FAILED
  );

  for (const record of failed) {
    record.settlementStatus = SETTLEMENT_STATUS.PENDING;
    record.updatedAt        = Date.now();
    enqueueJob(QUEUES.SETTLEMENT, { txRef: record.txRef, amount: record.amount, fromPhone: record.fromPhone, toPhone: record.toPhone });
  }

  writeSettlements(store);
  console.info(`[Settlement] Retrying ${failed.length} failed settlements`);
  return runSettlementQueue();
}

/**
 * Reverse a settled transaction.
 * Creates a reversal record and emits a PAYMENT_REVERSED event.
 * The actual ledger reversal entries are handled by ledger.js reverseTransaction().
 */
export function reverseSettlement(txRef, reason = 'Customer reversal request') {
  const store  = readSettlements();
  const record = store[txRef];

  if (!record) {
    console.warn(`[Settlement] Reverse failed — no record for ${txRef}`);
    return null;
  }

  if (record.settlementStatus === SETTLEMENT_STATUS.REVERSED) {
    console.warn(`[Settlement] Already reversed — ${txRef}`);
    return record;
  }

  const reversalRef = generateReversalRef(txRef);
  record.settlementStatus = SETTLEMENT_STATUS.REVERSED;
  record.reversalRef      = reversalRef;
  record.failureReason    = reason;
  record.updatedAt        = Date.now();

  // Create reversal settlement record
  store[reversalRef] = {
    ...createSettlementRecord(reversalRef, record.amount, record.toPhone, record.fromPhone, null),
    settlementStatus: SETTLEMENT_STATUS.SETTLED,
    settledAt:        Date.now(),
  };

  writeSettlements(store);
  emitPaymentEvent('PAYMENT_REVERSED', { txRef, reversalRef, reason });
  emit(EVENTS.SETTLEMENT_UPDATED, { txRef, reversalRef, reason, status: SETTLEMENT_STATUS.REVERSED });
  console.info(`[Settlement] Reversed ${txRef} → ${reversalRef}`);
  return record;
}

/**
 * Flag a settled transaction as disputed.
 */
export function disputeSettlement(txRef, disputeRef) {
  const store  = readSettlements();
  const record = store[txRef];
  if (!record) return null;

  record.settlementStatus = SETTLEMENT_STATUS.DISPUTED;
  record.disputeRef       = disputeRef || `DSP-${txRef}`;
  record.updatedAt        = Date.now();

  writeSettlements(store);
  emitPaymentEvent('PAYMENT_DISPUTED', { txRef, disputeRef: record.disputeRef });
  emit(EVENTS.SETTLEMENT_UPDATED, { txRef, disputeRef: record.disputeRef, status: SETTLEMENT_STATUS.DISPUTED });
  return record;
}

/**
 * Get the current settlement record for a txRef.
 */
export function getSettlementStatus(txRef) {
  const store = readSettlements();
  return store[txRef] || null;
}

/**
 * Get all settlement records (for audit/reconciliation use).
 */
export function getAllSettlements() {
  return readSettlements();
}

// ── Event Emitter ─────────────────────────────────────────────────────────────

function emitPaymentEvent(eventType, data) {
  console.info(`[PaymentEvent] ${eventType}`, {
    eventType,
    timestamp:   new Date().toISOString(),
    environment: 'demo',
    ...data,
  });

  // Dispatch custom DOM event so UI components can subscribe if needed
  window.dispatchEvent(new CustomEvent('zuri_payment_event', {
    detail: { eventType, timestamp: Date.now(), ...data },
  }));
}
