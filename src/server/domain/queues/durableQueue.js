/**
 * Durable Queue — persistent job queue for Zuri Connect Africa.
 *
 * Provides a multi-queue, priority-aware job system:
 *   • Persistent (IndexedDB primary, localStorage fallback)
 *   • Idempotent enqueue (same key never processed twice)
 *   • Exponential backoff with ±30% jitter (reconnect-storm-safe)
 *   • Dead-letter queue (DLQ) after maxAttempts exhausted
 *   • Per-queue concurrency control
 *   • Job locking (claimed_by / lock_expires_at pattern — prevents double-processing)
 *   • Visibility timeout auto-release (stale locks expire and re-queue)
 *
 * Named queues:
 *   payments        — send money, airtime, paybill (priority 10)
 *   settlements     — provider settlement calls (priority 20)
 *   notifications   — SMS, push, in-app (priority 30)
 *   fraud           — async fraud graph updates (priority 40)
 *   reconciliation  — background reconciliation runs (priority 50)
 *   audit           — audit log persistence (priority 60)
 */

import { recordOperation, SERVICES } from '@/server/domain/observability/telemetryService';

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME     = 'zuri_queue_v1';
const DB_VERSION  = 1;
const STORE_JOBS  = 'jobs';
const STORE_DLQ   = 'dlq';
const LS_FALLBACK = 'zuri_queue_fallback_v1';

const LOCK_TTL_MS         = 60_000;   // 60s visibility timeout
const MAX_LS_JOBS         = 500;
const WORKER_POLL_MS      = 2_000;    // poll interval per queue worker

export const QUEUE_NAMES = Object.freeze({
  PAYMENTS:       'payments',
  SETTLEMENTS:    'settlements',
  NOTIFICATIONS:  'notifications',
  FRAUD:          'fraud',
  RECONCILIATION: 'reconciliation',
  AUDIT:          'audit',
});

export const QUEUE_PRIORITIES = Object.freeze({
  [QUEUE_NAMES.PAYMENTS]:       10,
  [QUEUE_NAMES.SETTLEMENTS]:    20,
  [QUEUE_NAMES.NOTIFICATIONS]:  30,
  [QUEUE_NAMES.FRAUD]:          40,
  [QUEUE_NAMES.RECONCILIATION]: 50,
  [QUEUE_NAMES.AUDIT]:          60,
});

export const JOB_STATUS = Object.freeze({
  QUEUED:      'queued',
  PROCESSING:  'processing',
  COMPLETED:   'completed',
  FAILED:      'failed',
  DEAD_LETTER: 'dead_letter',
  CANCELLED:   'cancelled',
});

// ── Worker registry (local handlers) ─────────────────────────────────────────

const _handlers   = new Map();  // queueName → async (job) => any
const _workers    = new Map();  // queueName → intervalId
const _workerId   = `worker_${Date.now().toString(36)}`;

// ── FNV-1a ────────────────────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function genJobId() {
  return `job_${fnv1a(Date.now() + Math.random().toString())}_${Date.now().toString(36)}`;
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

let _db = null;
let _dbInitPromise = null;

function openDB() {
  if (_db)           return Promise.resolve(_db);
  if (_dbInitPromise) return _dbInitPromise;

  _dbInitPromise = new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_JOBS)) {
          const js = db.createObjectStore(STORE_JOBS, { keyPath: 'id' });
          js.createIndex('by_queue_status',  ['queueName', 'status'], { unique: false });
          js.createIndex('by_idempotency',   'idempotencyKey',        { unique: false });
          js.createIndex('by_next_run',      'nextRunAt',             { unique: false });
        }
        if (!db.objectStoreNames.contains(STORE_DLQ)) {
          const ds = db.createObjectStore(STORE_DLQ, { keyPath: 'id' });
          ds.createIndex('by_queue',  'queueName', { unique: false });
        }
      };
      req.onsuccess  = (e) => { _db = e.target.result; resolve(_db); };
      req.onerror    = () => reject(req.error);
      req.onblocked  = () => reject(new Error('IDB blocked'));
    } catch (err) { reject(err); }
  });

  return _dbInitPromise;
}

async function idbPut(store, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(record);
    req.onsuccess = () => resolve(record);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGet(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGetByIndex(store, indexName, query) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).index(indexName).getAll(query);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function idbDelete(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── localStorage fallback ─────────────────────────────────────────────────────

function lsJobs() {
  try { return JSON.parse(localStorage.getItem(LS_FALLBACK) || '[]'); } catch { return []; }
}

function lsSaveJobs(jobs) {
  try {
    const trimmed = jobs.slice(-MAX_LS_JOBS);
    localStorage.setItem(LS_FALLBACK, JSON.stringify(trimmed));
  } catch {}
}

async function persistJob(job) {
  try {
    await idbPut(STORE_JOBS, job);
  } catch {
    const jobs = lsJobs().filter(j => j.id !== job.id);
    jobs.push(job);
    lsSaveJobs(jobs);
  }
}

async function loadJobsByQueueStatus(queueName, status) {
  try {
    return await idbGetByIndex(STORE_JOBS, 'by_queue_status', [queueName, status]);
  } catch {
    return lsJobs().filter(j => j.queueName === queueName && j.status === status);
  }
}

async function loadJobByIdempotency(key) {
  try {
    const results = await idbGetByIndex(STORE_JOBS, 'by_idempotency', key);
    return results[0] || null;
  } catch {
    return lsJobs().find(j => j.idempotencyKey === key) || null;
  }
}

// ── Backoff calculation ───────────────────────────────────────────────────────

function calcBackoff(attempt, baseMs = 1000, maxMs = 300_000) {
  const base   = Math.min(baseMs * Math.pow(2, attempt), maxMs);
  const jitter = base * 0.3 * (Math.random() * 2 - 1);
  return Math.round(Math.max(500, base + jitter));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Enqueue a job.
 *
 * @param {object} params
 * @param {string} params.queueName       — QUEUE_NAMES constant
 * @param {string} params.jobType         — descriptive job type (e.g. 'send_money')
 * @param {object} params.payload         — arbitrary job data
 * @param {string} [params.idempotencyKey] — if provided, deduplicates enqueue
 * @param {number} [params.priority]      — 0 = highest (overrides queue default)
 * @param {number} [params.maxAttempts]   — default 5
 * @param {number} [params.runAfterMs]    — delay before first attempt (ms)
 * @param {string} [params.correlationId]
 * @returns {Promise<{ jobId: string, deduplicated: boolean }>}
 */
export async function enqueue(params) {
  const {
    queueName,
    jobType,
    payload,
    idempotencyKey = null,
    priority = QUEUE_PRIORITIES[queueName] ?? 50,
    maxAttempts = 5,
    runAfterMs = 0,
    correlationId = null,
  } = params;

  // ── Idempotency check ──
  if (idempotencyKey) {
    const existing = await loadJobByIdempotency(idempotencyKey).catch(() => null);
    if (existing && existing.status !== JOB_STATUS.DEAD_LETTER) {
      return { jobId: existing.id, deduplicated: true };
    }
  }

  const job = {
    id:             genJobId(),
    queueName,
    jobType,
    payload,
    idempotencyKey,
    priority,
    status:         JOB_STATUS.QUEUED,
    attempts:       0,
    maxAttempts,
    nextRunAt:      Date.now() + runAfterMs,
    createdAt:      Date.now(),
    updatedAt:      Date.now(),
    claimedBy:      null,
    claimedAt:      null,
    lockExpiresAt:  null,
    lastError:      null,
    completedAt:    null,
    correlationId,
  };

  await persistJob(job);
  return { jobId: job.id, deduplicated: false };
}

/**
 * Claim the next available job from a queue (for a worker to process).
 * Implements optimistic locking — the job is marked 'processing' for LOCK_TTL_MS.
 *
 * @param {string} queueName
 * @returns {Promise<object|null>} job or null if queue is empty
 */
export async function claimNextJob(queueName) {
  try {
    const now     = Date.now();
    const queued  = await loadJobsByQueueStatus(queueName, JOB_STATUS.QUEUED);

    // Also reclaim stale locks
    const processing = await loadJobsByQueueStatus(queueName, JOB_STATUS.PROCESSING);
    const stale      = processing.filter(j => j.lockExpiresAt && j.lockExpiresAt < now);
    for (const j of stale) {
      j.status       = JOB_STATUS.QUEUED;
      j.claimedBy    = null;
      j.claimedAt    = null;
      j.lockExpiresAt = null;
      await persistJob(j);
    }

    // Filter eligible jobs (past nextRunAt, sorted by priority asc then nextRunAt asc)
    const eligible = [...queued, ...stale]
      .filter(j => j.nextRunAt <= now && j.status === JOB_STATUS.QUEUED)
      .sort((a, b) => a.priority - b.priority || a.nextRunAt - b.nextRunAt);

    const job = eligible[0];
    if (!job) return null;

    job.status        = JOB_STATUS.PROCESSING;
    job.claimedBy     = _workerId;
    job.claimedAt     = now;
    job.lockExpiresAt = now + LOCK_TTL_MS;
    job.updatedAt     = now;
    await persistJob(job);

    return job;
  } catch { return null; }
}

/**
 * Mark a job as completed.
 */
export async function completeJob(jobId, result = null) {
  try {
    let job;
    try { job = await idbGet(STORE_JOBS, jobId); }
    catch { job = lsJobs().find(j => j.id === jobId); }
    if (!job) return false;

    job.status      = JOB_STATUS.COMPLETED;
    job.completedAt = Date.now();
    job.updatedAt   = Date.now();
    job.result      = result;
    await persistJob(job);
    recordOperation(SERVICES.QUEUE, `complete:${job.queueName}`, Date.now() - (job.claimedAt || Date.now()), true);
    return true;
  } catch { return false; }
}

/**
 * Mark a job as failed. Schedules retry or moves to DLQ if exhausted.
 *
 * @param {string} jobId
 * @param {string} error      — error message
 * @param {object} [opts]
 * @param {boolean} [opts.fatal] — if true, skip retry and go directly to DLQ
 */
export async function failJob(jobId, error, opts = {}) {
  try {
    let job;
    try { job = await idbGet(STORE_JOBS, jobId); }
    catch { job = lsJobs().find(j => j.id === jobId); }
    if (!job) return false;

    job.attempts++;
    job.lastError  = error;
    job.updatedAt  = Date.now();
    job.claimedBy  = null;
    job.claimedAt  = null;
    job.lockExpiresAt = null;

    if (opts.fatal || job.attempts >= job.maxAttempts) {
      job.status = JOB_STATUS.DEAD_LETTER;
      await idbPut(STORE_DLQ, { ...job, movedToDLQAt: Date.now() }).catch(() => {});
    } else {
      job.status    = JOB_STATUS.QUEUED;
      job.nextRunAt = Date.now() + calcBackoff(job.attempts);
    }

    await persistJob(job);
    recordOperation(SERVICES.QUEUE, `fail:${job.queueName}`, 0, false);
    return true;
  } catch { return false; }
}

/**
 * Cancel a job. Only possible if still QUEUED.
 */
export async function cancelJob(jobId) {
  try {
    let job;
    try { job = await idbGet(STORE_JOBS, jobId); }
    catch { job = lsJobs().find(j => j.id === jobId); }
    if (!job || job.status !== JOB_STATUS.QUEUED) return false;

    job.status    = JOB_STATUS.CANCELLED;
    job.updatedAt = Date.now();
    await persistJob(job);
    return true;
  } catch { return false; }
}

// ── Worker registration ───────────────────────────────────────────────────────

/**
 * Register a handler for a queue and start polling.
 *
 * @param {string}   queueName
 * @param {Function} handler    — async (job) => any — may throw to trigger failure
 * @param {object}   [opts]
 * @param {number}   [opts.pollIntervalMs]
 * @param {number}   [opts.concurrency]    — max parallel jobs (default 1)
 */
export function registerWorker(queueName, handler, opts = {}) {
  if (_workers.has(queueName)) return;

  _handlers.set(queueName, handler);
  const interval = opts.pollIntervalMs || WORKER_POLL_MS;
  const concurrency = opts.concurrency || 1;

  const timerId = setInterval(async () => {
    for (let i = 0; i < concurrency; i++) {
      const job = await claimNextJob(queueName).catch(() => null);
      if (!job) break;

      const t0 = performance.now();
      try {
        const result = await handler(job);
        await completeJob(job.id, result);
      } catch (err) {
        await failJob(job.id, err?.message || 'handler_error');
      }
    }
  }, interval);

  _workers.set(queueName, timerId);
}

/**
 * Stop a queue worker.
 */
export function stopWorker(queueName) {
  const timerId = _workers.get(queueName);
  if (timerId) { clearInterval(timerId); _workers.delete(queueName); }
}

// ── DLQ management ────────────────────────────────────────────────────────────

export async function getDLQ(queueName = null) {
  try {
    if (queueName) {
      return await idbGetByIndex(STORE_DLQ, 'by_queue', queueName);
    }
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx  = db.transaction(STORE_DLQ, 'readonly');
      const req = tx.objectStore(STORE_DLQ).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  } catch { return []; }
}

export async function retryDLQJob(jobId) {
  try {
    const job = await idbGet(STORE_DLQ, jobId).catch(() => null);
    if (!job) return false;
    const requeued = { ...job, status: JOB_STATUS.QUEUED, attempts: 0, nextRunAt: Date.now() };
    await idbDelete(STORE_DLQ, jobId);
    await persistJob(requeued);
    return true;
  } catch { return false; }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function getQueueStats() {
  const stats = {};
  for (const queueName of Object.values(QUEUE_NAMES)) {
    try {
      const queued     = await loadJobsByQueueStatus(queueName, JOB_STATUS.QUEUED);
      const processing = await loadJobsByQueueStatus(queueName, JOB_STATUS.PROCESSING);
      const dlq        = await idbGetByIndex(STORE_DLQ, 'by_queue', queueName).catch(() => []);
      stats[queueName] = {
        queued:     queued.length,
        processing: processing.length,
        dlq:        dlq.length,
        hasWorker:  _workers.has(queueName),
      };
    } catch {
      stats[queueName] = { queued: 0, processing: 0, dlq: 0, hasWorker: false };
    }
  }
  return stats;
}
