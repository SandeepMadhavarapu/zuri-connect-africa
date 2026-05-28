/**
 * Zuri Connect Africa - durable local job queue
 * Preserves the original API while adding crash recovery, priority ordering,
 * replay protection, poison handling, and dead-letter metadata.
 */

const QUEUE_PREFIX = 'zuri_queue_durable_';
const DLQ_KEY = 'zuri_dlq_durable_v2';
const PROCESSING_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_RETRIES = 5;

export const QUEUES = {
  SETTLEMENT: 'settlement',
  FRAUD: 'fraud',
  NOTIFICATION: 'notification',
  RECONCILIATION: 'reconciliation',
};

export const JOB_PRIORITY = {
  LOW: 1,
  NORMAL: 5,
  HIGH: 10,
  CRITICAL: 20,
};

function storageKey(queue) {
  return `${QUEUE_PREFIX}${queue}`;
}

function safeRead(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function safeWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function readQueue(queue) {
  return safeRead(storageKey(queue), []);
}

function writeQueue(queue, jobs) {
  safeWrite(storageKey(queue), jobs);
}

function readDLQ() {
  return safeRead(DLQ_KEY, []);
}

function writeDLQ(jobs) {
  safeWrite(DLQ_KEY, jobs.slice(-1000));
}

function backoffMs(retryCount) {
  const base = Math.min(1000 * Math.pow(2, retryCount), 60000);
  const jitter = Math.floor(Math.random() * Math.min(base * 0.25, 2000));
  return base + jitter;
}

function generateJobId() {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function dedupeKey(queue, payload = {}) {
  return payload.idempotencyKey ||
    payload.txRef ||
    payload.correlationId ||
    `${queue}:${JSON.stringify(payload).slice(0, 256)}`;
}

function recoverStaleProcessingJobs(queue, jobs) {
  const now = Date.now();
  let recovered = 0;
  jobs.forEach(job => {
    if (job.status === 'processing' && job.startedAt && now - job.startedAt > PROCESSING_TIMEOUT_MS) {
      job.status = 'failed';
      job.nextRetryAt = now + backoffMs(job.retryCount || 0);
      job.lastError = 'processing_timeout_recovered_after_crash';
      recovered += 1;
    }
  });
  if (recovered) {
    writeQueue(queue, jobs);
    console.warn(`[Queue:${queue}] Recovered ${recovered} stale processing jobs`);
  }
  return jobs;
}

function deadLetter(queue, jobs, job, error) {
  job.status = 'dead';
  job.deadAt = Date.now();
  job.lastError = error?.message || String(error || job.lastError || 'unknown_error');

  const dlq = readDLQ();
  dlq.push({
    ...job,
    queue,
    failureReason: job.lastError,
    payloadSnapshot: job.payload,
  });
  writeDLQ(dlq);
  writeQueue(queue, jobs);
  console.warn(`[Queue:${queue}] Dead-letter ${job.jobId} after ${job.retryCount} retries`);
}

export function enqueueJob(queue, payload, opts = {}) {
  const jobs = recoverStaleProcessingJobs(queue, readQueue(queue));
  const key = opts.dedupeKey || dedupeKey(queue, payload);

  const existing = jobs.find(job =>
    job.dedupeKey === key &&
    !['completed', 'dead'].includes(job.status)
  );
  if (existing) {
    console.info(`[Queue:${queue}] Duplicate suppressed - key ${key}`);
    return existing;
  }

  const job = {
    jobId: generateJobId(),
    queue,
    txRef: payload.txRef || null,
    dedupeKey: key,
    payload,
    priority: opts.priority ?? JOB_PRIORITY.NORMAL,
    status: 'pending',
    retryCount: 0,
    poisonCount: 0,
    createdAt: Date.now(),
    startedAt: null,
    processedAt: null,
    completedAt: null,
    nextRetryAt: null,
    lastError: null,
    correlationId: payload.correlationId || opts.correlationId || null,
  };

  jobs.push(job);
  writeQueue(queue, jobs);
  console.info(`[Queue:${queue}] Enqueued ${job.jobId}`, payload);
  return job;
}

export async function processQueue(queue, handler) {
  const jobs = recoverStaleProcessingJobs(queue, readQueue(queue));
  const now = Date.now();
  const eligible = jobs
    .filter(job =>
      job.status === 'pending' ||
      (job.status === 'failed' && job.nextRetryAt && now >= job.nextRetryAt)
    )
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || (a.createdAt || 0) - (b.createdAt || 0));

  for (const job of eligible) {
    await new Promise(resolve => setTimeout(resolve, 0));

    job.status = 'processing';
    job.startedAt = Date.now();
    job.processedAt = Date.now();
    writeQueue(queue, jobs);

    try {
      const outcome = await handler(job);
      if (!outcome?.success) {
        throw new Error(outcome?.error || 'Handler returned failure');
      }

      job.status = 'completed';
      job.completedAt = Date.now();
      job.lastError = null;
      job.result = outcome.result || outcome.record || null;
      console.info(`[Queue:${queue}] Completed ${job.jobId}`);
    } catch (err) {
      const errorText = err?.message || String(err);
      job.retryCount += 1;
      job.lastError = errorText;
      job.poisonCount = errorText === job.previousError ? (job.poisonCount || 0) + 1 : 1;
      job.previousError = errorText;

      if (job.retryCount >= MAX_RETRIES || job.poisonCount >= 3) {
        deadLetter(queue, jobs, job, err);
        continue;
      }

      job.status = 'failed';
      job.nextRetryAt = Date.now() + backoffMs(job.retryCount);
      console.warn(`[Queue:${queue}] Failed ${job.jobId}, retry ${job.retryCount} scheduled`);
    }

    writeQueue(queue, jobs);
  }

  return jobs;
}

export function retryJob(queue, jobId) {
  const jobs = readQueue(queue);
  const job = jobs.find(item => item.jobId === jobId);
  if (!job) return null;

  job.status = 'pending';
  job.nextRetryAt = null;
  job.lastError = null;
  writeQueue(queue, jobs);
  return job;
}

export function recoverQueue(queue) {
  return recoverStaleProcessingJobs(queue, readQueue(queue));
}

export function getQueueJobs(queue) {
  return recoverStaleProcessingJobs(queue, readQueue(queue));
}

export function getDeadLetterJobs() {
  return readDLQ();
}

export function getQueueStats(queue) {
  const jobs = getQueueJobs(queue);
  return {
    total: jobs.length,
    pending: jobs.filter(job => job.status === 'pending').length,
    processing: jobs.filter(job => job.status === 'processing').length,
    completed: jobs.filter(job => job.status === 'completed').length,
    failed: jobs.filter(job => job.status === 'failed').length,
    dead: jobs.filter(job => job.status === 'dead').length,
  };
}

export function getAllQueueStats() {
  return Object.fromEntries(Object.values(QUEUES).map(queue => [queue, getQueueStats(queue)]));
}
