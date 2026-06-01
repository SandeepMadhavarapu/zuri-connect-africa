/**
 * Webhook dead-letter queue with exponential retry metadata.
 */

import { emit } from '@/lib/eventBus';
import { obs } from '@/lib/observability';
import { logWebhookAudit } from './webhookAudit';
import { updateWebhookState, WEBHOOK_STATE } from './webhookIdempotency';

const DLQ_KEY = 'zuri_webhook_dead_letters_v1';
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60 * 1000;
export const MAX_WEBHOOK_RETRIES = 5;

function readDeadLetters() {
  try {
    return JSON.parse(localStorage.getItem(DLQ_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeDeadLetters(entries) {
  try {
    localStorage.setItem(DLQ_KEY, JSON.stringify(entries));
  } catch {
    // Keep console/audit as fallback.
  }
}

export function calculateWebhookBackoffMs(retryCount) {
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(BASE_BACKOFF_MS * Math.pow(2, retryCount), MAX_BACKOFF_MS) + jitter;
}

export function shouldRetryWebhook(job, maxRetries = MAX_WEBHOOK_RETRIES) {
  return (job.retryCount || 0) < maxRetries;
}

export function moveWebhookToDeadLetter(job, error) {
  const deadLetters = readDeadLetters();
  const entry = {
    ...job,
    status: 'dead',
    deadAt: Date.now(),
    deadAtIso: new Date().toISOString(),
    lastError: error?.message || String(error || job.lastError || 'unknown_error'),
    failureReason: error?.message || String(error || job.lastError || 'unknown_error'),
    payloadSnapshot: job.payload,
  };

  deadLetters.push(entry);
  writeDeadLetters(deadLetters);

  updateWebhookState({
    webhookId: job.webhookId,
    txRef: job.txRef,
    payloadHash: job.payloadHash,
    state: WEBHOOK_STATE.DEAD,
    error: entry.lastError,
    jobId: job.jobId,
  });

  logWebhookAudit('webhook.deadlettered', {
    webhookId: job.webhookId,
    txRef: job.txRef,
    correlationId: job.correlationId,
    retryCount: job.retryCount,
    queueStatus: 'dead',
    lastError: entry.lastError,
  });

  emit('webhook.deadlettered', entry);
  obs.track('webhook_dead_letter_queue_depth', deadLetters.length);
  return entry;
}

export function getWebhookDeadLetters({ txRef, correlationId } = {}) {
  return readDeadLetters()
    .filter(entry => !txRef || entry.txRef === txRef)
    .filter(entry => !correlationId || entry.correlationId === correlationId);
}

export function getWebhookDeadLetterDepth() {
  return readDeadLetters().length;
}

export function retryWebhookDeadLetter(jobId) {
  const deadLetters = readDeadLetters();
  const index = deadLetters.findIndex(entry => entry.jobId === jobId);
  if (index === -1) return null;

  const [entry] = deadLetters.splice(index, 1);
  writeDeadLetters(deadLetters);
  return {
    ...entry,
    status: 'pending',
    retryCount: 0,
    nextRetryAt: null,
    lastError: null,
  };
}
