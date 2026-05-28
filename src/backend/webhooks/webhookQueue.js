/**
 * Async webhook processing queue.
 * The HTTP handler only verifies, deduplicates, enqueues, and returns 200.
 */

import { emit } from '@/lib/eventBus';
import { obs } from '@/lib/observability';
import { calculateWebhookBackoffMs, moveWebhookToDeadLetter, shouldRetryWebhook } from './deadLetterQueue';
import { logWebhookAudit } from './webhookAudit';
import { updateWebhookState, WEBHOOK_STATE } from './webhookIdempotency';

const QUEUE_KEY = 'zuri_webhook_queue_v1';
const WEBHOOK_PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;

function readQueue() {
  try {
    return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeQueue(jobs) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(jobs));
  } catch {
    // Queue persistence is best-effort in the local demo runtime.
  }
}

function recoverStaleWebhookJobs(jobs) {
  const now = Date.now();
  let recovered = 0;
  jobs.forEach(job => {
    if (job.status === 'processing' && job.startedAt && now - job.startedAt > WEBHOOK_PROCESSING_TIMEOUT_MS) {
      job.status = 'failed';
      job.nextRetryAt = now;
      job.lastError = 'webhook_processing_timeout_recovered_after_crash';
      recovered += 1;
    }
  });
  if (recovered) writeQueue(jobs);
  return jobs;
}

function generateJobId() {
  return `wh_job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function enqueueWebhookJob({ webhookId, txRef, payloadHash, payload, normalizedEvent, correlationId, sourceIp }) {
  const jobs = recoverStaleWebhookJobs(readQueue());
  const existing = jobs.find(job =>
    job.status !== 'completed' &&
    job.status !== 'dead' &&
    ((webhookId && job.webhookId === webhookId) || (txRef && job.txRef === txRef) || (payloadHash && job.payloadHash === payloadHash))
  );

  if (existing) return { ...existing, duplicate: true };

  const job = {
    jobId: generateJobId(),
    queue: 'daraja-webhooks',
    webhookId,
    txRef,
    payloadHash,
    payload,
    normalizedEvent,
    correlationId,
    sourceIp,
    status: 'pending',
    priority: normalizedEvent?.status === 'failed' ? 20 : 10,
    retryCount: 0,
    createdAt: Date.now(),
    createdAtIso: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    nextRetryAt: null,
    lastError: null,
  };

  jobs.push(job);
  writeQueue(jobs);

  updateWebhookState({ webhookId, txRef, payloadHash, state: WEBHOOK_STATE.QUEUED, jobId: job.jobId });
  logWebhookAudit('webhook.queued', {
    webhookId,
    txRef,
    correlationId,
    sourceIp,
    queueStatus: 'pending',
  });
  obs.track('webhook_queue_depth', jobs.filter(item => item.status === 'pending').length);

  return job;
}

export async function processWebhookQueue(handler) {
  const jobs = recoverStaleWebhookJobs(readQueue());
  const now = Date.now();
  const eligible = jobs.filter(job =>
    job.status === 'pending' ||
    (job.status === 'failed' && job.nextRetryAt && job.nextRetryAt <= now)
  ).sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.createdAt || 0) - (b.createdAt || 0));

  for (const job of eligible) {
    await new Promise(resolve => setTimeout(resolve, 0));

    const started = performance.now();
    job.status = 'processing';
    job.startedAt = Date.now();
    job.lastError = null;
    updateWebhookState({
      webhookId: job.webhookId,
      txRef: job.txRef,
      payloadHash: job.payloadHash,
      state: WEBHOOK_STATE.PROCESSING,
      jobId: job.jobId,
    });
    writeQueue(jobs);

    try {
      const result = await handler(job);
      const durationMs = Math.round(performance.now() - started);

      job.status = 'completed';
      job.completedAt = Date.now();
      job.processingDurationMs = durationMs;

      updateWebhookState({
        webhookId: job.webhookId,
        txRef: job.txRef,
        payloadHash: job.payloadHash,
        state: WEBHOOK_STATE.COMPLETED,
        result,
        jobId: job.jobId,
      });

      logWebhookAudit('webhook.processed', {
        webhookId: job.webhookId,
        txRef: job.txRef,
        correlationId: job.correlationId,
        processingDurationMs: durationMs,
        retryCount: job.retryCount,
        queueStatus: 'completed',
        settlementOutcome: result?.settlementOutcome || result?.status || 'processed',
      });
      obs.track('webhook_latency_ms', durationMs, { type: job.normalizedEvent?.type || 'unknown' });
      obs.track('webhook_callback_success_rate', 1, { status: 'success' });
    } catch (err) {
      job.retryCount += 1;
      job.lastError = err.message || String(err);

      if (shouldRetryWebhook(job)) {
        job.status = 'failed';
        job.nextRetryAt = Date.now() + calculateWebhookBackoffMs(job.retryCount);
        updateWebhookState({
          webhookId: job.webhookId,
          txRef: job.txRef,
          payloadHash: job.payloadHash,
          state: WEBHOOK_STATE.FAILED,
          error: job.lastError,
          jobId: job.jobId,
        });

        logWebhookAudit('webhook.retry_scheduled', {
          webhookId: job.webhookId,
          txRef: job.txRef,
          correlationId: job.correlationId,
          retryCount: job.retryCount,
          queueStatus: 'failed',
          lastError: job.lastError,
        });
        obs.track('webhook_retry_rate', 1);
      } else {
        job.status = 'dead';
        moveWebhookToDeadLetter(job, err);
      }
    }

    writeQueue(jobs);
  }

  return jobs;
}

export function getWebhookQueue() {
  return recoverStaleWebhookJobs(readQueue());
}

export function getWebhookQueueStats() {
  const jobs = getWebhookQueue();
  return {
    total: jobs.length,
    pending: jobs.filter(job => job.status === 'pending').length,
    processing: jobs.filter(job => job.status === 'processing').length,
    completed: jobs.filter(job => job.status === 'completed').length,
    failed: jobs.filter(job => job.status === 'failed').length,
    dead: jobs.filter(job => job.status === 'dead').length,
  };
}

export function emitWebhookQueueEvents(job) {
  emit('settlement.updated', {
    txRef: job.txRef,
    webhookId: job.webhookId,
    correlationId: job.correlationId,
    status: job.status,
  });
}
