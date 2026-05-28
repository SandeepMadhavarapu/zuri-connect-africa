/**
 * Zuri Connect Africa — Offline Resilience Queue v2
 *
 * Architecture:
 *   - IndexedDB primary store (survives page reloads, larger quota than localStorage)
 *   - localStorage fallback for environments without IndexedDB
 *   - Idempotency keys prevent duplicate payments on retry
 *   - Exponential backoff with jitter for unstable networks
 *   - Priority queuing: financial > account > analytics
 *   - Connection quality scoring via Network Information API + RTT probing
 */

import { emit } from './eventBus';
import { devInfo, devWarn } from './devLog.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME     = 'zuri_resilience';
const DB_VERSION  = 2;
const STORE_NAME  = 'offline_queue';
const LS_FALLBACK = 'zuri_offline_queue_v2';

export const CONNECTION_QUALITY = {
  OFFLINE: 'offline',
  POOR:    'poor',
  FAIR:    'fair',
  GOOD:    'good',
};

// Priority: higher = processed first
export const ACTION_PRIORITY = {
  FINANCIAL:  10,  // send_money, paybill, airtime purchase
  ACCOUNT:    5,   // profile update, KYC
  ANALYTICS:  1,   // tracking, telemetry
};

// Backoff config (ms)
const BACKOFF_BASE    = 2000;
const BACKOFF_CAP     = 120000;  // 2 minutes max
const BACKOFF_JITTER  = 0.3;     // ±30% jitter to prevent thundering herd
const MAX_RETRIES     = 7;
const OFFLINE_MAX_AGE_MS = 15 * 60 * 1000;
const OFFLINE_REPLAY_KEY = 'zuri_offline_replay_cache_v1';
const OFFLINE_DEVICE_SECRET_KEY = 'zuri_offline_device_secret_v1';

// ── Action handler registry ───────────────────────────────────────────────────

const _actionHandlers  = {};
const _reconnectHooks  = [];

export function registerActionHandler(action, handler) {
  _actionHandlers[action] = handler;
}

export function onReconnect(handler) {
  _reconnectHooks.push(handler);
}

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    
    // Timeout protection — IndexedDB can hang indefinitely
    const timeout = setTimeout(() => {
      devWarn('[OfflineQueue] IndexedDB open timeout - using fallback');
      resolve(null);
    }, 3000);

    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        try {
          const db = e.target.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'actionId' });
            store.createIndex('status',    'status',    { unique: false });
            store.createIndex('priority',  'priority',  { unique: false });
            store.createIndex('createdAt', 'createdAt', { unique: false });
          }
        } catch (e) {
          devWarn('[OfflineQueue] Upgrade failed:', e?.message);
        }
      };
      req.onsuccess = (e) => {
        clearTimeout(timeout);
        _db = e.target.result;
        resolve(_db);
      };
      req.onerror = () => {
        clearTimeout(timeout);
        devWarn('[OfflineQueue] IndexedDB open failed - using fallback');
        resolve(null);
      };
      req.onblocked = () => {
        clearTimeout(timeout);
        devWarn('[OfflineQueue] IndexedDB blocked - using fallback');
        resolve(null);
      };
    } catch (e) {
      clearTimeout(timeout);
      devWarn('[OfflineQueue] IndexedDB access failed:', e?.message);
      resolve(null);
    }
  });
}

async function dbGetAll() {
  const db = await openDB();
  if (!db) return lsReadQueue();
  return new Promise((resolve) => {
    const tx    = db.transaction(STORE_NAME, 'readonly');
    const req   = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => resolve(lsReadQueue());
  });
}

async function dbPut(entry) {
  const db = await openDB();
  if (!db) { lsUpdateEntry(entry); return; }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => {
      lsUpdateEntry(entry);
      resolve();
    };
    tx.onerror    = () => lsUpdateEntry(entry);
  });
}

async function dbDelete(actionId) {
  const db = await openDB();
  if (!db) { lsDeleteEntry(actionId); return; }
  return new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(actionId);
    tx.oncomplete = () => {
      lsDeleteEntry(actionId);
      resolve();
    };
    tx.onerror    = resolve;
  });
}

// ── localStorage fallback ─────────────────────────────────────────────────────

function lsReadQueue() {
  try { return JSON.parse(localStorage.getItem(LS_FALLBACK) || '[]'); } catch { return []; }
}

function lsWriteQueue(q) {
  try { localStorage.setItem(LS_FALLBACK, JSON.stringify(q)); } catch {}
}

function lsUpdateEntry(entry) {
  const q = lsReadQueue();
  const i = q.findIndex(x => x.actionId === entry.actionId);
  if (i >= 0) q[i] = entry; else q.push(entry);
  lsWriteQueue(q);
}

function lsDeleteEntry(actionId) {
  lsWriteQueue(lsReadQueue().filter(x => x.actionId !== actionId));
}

// ── Connection quality ────────────────────────────────────────────────────────

let _lastRttProbe   = 0;
let _lastRttMs      = null;
let _rttProbeActive = false;

/**
 * Lightweight RTT signal from the Network Information API.
 * Avoids browser fetch probes so production demos never spam Supabase /health.
 */
async function probeRtt() {
  const now = Date.now();
  if (_rttProbeActive || now - _lastRttProbe < 8000) return _lastRttMs;
  _rttProbeActive = true;
  _lastRttProbe   = now;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  _lastRttMs = typeof conn?.rtt === 'number' && conn.rtt > 0 ? conn.rtt : 100;
  _rttProbeActive = false;
  return _lastRttMs;
}

/**
 * Detect current connection quality.
 * Combines Network Information API + live RTT probe.
 * Returns: 'offline' | 'poor' | 'fair' | 'good'
 */
export async function detectConnectionQualityAsync() {
  if (!navigator.onLine) return CONNECTION_QUALITY.OFFLINE;

  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const napi = conn ? { effectiveType: conn.effectiveType, downlink: conn.downlink, rtt: conn.rtt } : {};

  // Hard offline signals from Network Information API
  if (napi.downlink === 0 || napi.effectiveType === 'slow-2g') return CONNECTION_QUALITY.POOR;

  // Probe RTT in parallel (non-blocking to UI)
  const rttMs = await probeRtt();

  if (rttMs === null)    return CONNECTION_QUALITY.OFFLINE;
  if (rttMs > 2500 || napi.rtt > 2000 || napi.effectiveType === '2g' || napi.downlink < 0.15)
    return CONNECTION_QUALITY.POOR;
  if (rttMs > 800  || napi.rtt > 700  || napi.downlink < 1)
    return CONNECTION_QUALITY.FAIR;
  return CONNECTION_QUALITY.GOOD;
}

/**
 * Synchronous best-effort quality using only Network Information API.
 * Use for non-critical UI decisions where async is undesirable.
 */
export function detectConnectionQuality() {
  if (!navigator.onLine) return CONNECTION_QUALITY.OFFLINE;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return CONNECTION_QUALITY.GOOD;
  const { effectiveType, downlink, rtt } = conn;
  if (effectiveType === 'slow-2g' || downlink < 0.15 || rtt > 2000) return CONNECTION_QUALITY.POOR;
  if (effectiveType === '2g'      || downlink < 1    || rtt > 800)  return CONNECTION_QUALITY.FAIR;
  return CONNECTION_QUALITY.GOOD;
}

/**
 * Returns true if the device is in a low-data / data-saver mode.
 * Drives lightweight rendering decisions across the app.
 */
export function isLowDataMode() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return false;
  return conn.saveData === true || conn.effectiveType === 'slow-2g' || conn.effectiveType === '2g';
}

// ── Idempotency ───────────────────────────────────────────────────────────────

/**
 * Generate a deterministic idempotency key for a transaction.
 * Same inputs → same key → safe to retry without double-payment.
 */
export function generateIdempotencyKey(action, payload) {
  const data = `${action}|${payload.phone || ''}|${payload.amount || ''}|${payload.ref || ''}|${Math.floor(Date.now() / 60000)}`;
  // Simple FNV-1a-inspired hash (no crypto dependency needed)
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= data.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `idmp_${h.toString(16).padStart(8, '0')}`;
}

function canonicalOfflinePayload(action, payload, idempotencyKey, expiresAt) {
  return JSON.stringify({
    action,
    idempotencyKey,
    expiresAt,
    amount: payload?.amount ?? null,
    phone: payload?.phone || payload?.toPhone || payload?.fromPhone || null,
    ref: payload?.ref || payload?.txRef || null,
  });
}

function getOfflineDeviceSecret() {
  let secret = localStorage.getItem(OFFLINE_DEVICE_SECRET_KEY);
  if (!secret) {
    secret = crypto.randomUUID?.() || `offline_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(OFFLINE_DEVICE_SECRET_KEY, secret);
  }
  return secret;
}

async function signOfflinePayload(action, payload, idempotencyKey, expiresAt) {
  const raw = `${getOfflineDeviceSecret()}|${canonicalOfflinePayload(action, payload, idempotencyKey, expiresAt)}`;
  if (!crypto?.subtle) {
    let h = 0x811c9dc5;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyOfflineSignature(entry) {
  if (!entry.signature || !entry.expiresAt) return { valid: false, reason: 'missing_offline_signature' };
  const expected = await signOfflinePayload(entry.action, entry.payload, entry.idempotencyKey, entry.expiresAt);
  return {
    valid: expected === entry.signature,
    reason: expected === entry.signature ? 'ok' : 'offline_signature_mismatch',
  };
}

function readReplayCache() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_REPLAY_KEY) || '{}'); } catch { return {}; }
}

function writeReplayCache(cache) {
  try { localStorage.setItem(OFFLINE_REPLAY_KEY, JSON.stringify(cache)); } catch {}
}

function markOfflineReplayComplete(entry) {
  const cache = readReplayCache();
  cache[entry.idempotencyKey] = {
    actionId: entry.actionId,
    syncedAt: Date.now(),
    txRef: entry.payload?.txRef || entry.payload?.ref || null,
  };
  writeReplayCache(cache);
}

async function validateOfflineEntry(entry) {
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    return { valid: false, reason: 'offline_action_stale' };
  }
  const replay = readReplayCache()[entry.idempotencyKey];
  if (replay) {
    return { valid: false, reason: 'offline_replay_duplicate', replay };
  }
  return verifyOfflineSignature(entry);
}

// ── Backoff calculator ────────────────────────────────────────────────────────

/**
 * Exponential backoff with ±30% random jitter.
 * Prevents thundering-herd reconnect storms on African cell towers.
 */
export function calcBackoffMs(retries) {
  const base   = Math.min(BACKOFF_BASE * Math.pow(2, retries), BACKOFF_CAP);
  const jitter = base * BACKOFF_JITTER;
  return Math.round(base + (Math.random() * 2 - 1) * jitter);
}

// ── Queue write helpers ───────────────────────────────────────────────────────

function makeEntry(action, payload, priority, idempotencyKey, signature, expiresAt) {
  return {
    actionId:        `oq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    idempotencyKey:  idempotencyKey || generateIdempotencyKey(action, payload),
    action,
    payload,
    signature,
    expiresAt,
    priority:        priority ?? ACTION_PRIORITY.ANALYTICS,
    status:          'pending',
    createdAt:       Date.now(),
    nextRetryAt:     Date.now(),
    syncedAt:        null,
    retries:         0,
    lastError:       null,
  };
}

// ── Public Queue API ──────────────────────────────────────────────────────────

/**
 * Enqueue an action for deferred processing.
 * @param {string} action         — action name, e.g. 'send_money'
 * @param {object} payload        — action data
 * @param {object} opts
 * @param {number} opts.priority  — ACTION_PRIORITY.*
 * @param {string} opts.idempotencyKey — override auto-generated key
 */
export async function enqueueOfflineAction(action, payload, opts = {}) {
  // Deduplicate: check idempotency key before inserting
  const ikey  = opts.idempotencyKey || generateIdempotencyKey(action, payload);
  const all   = await dbGetAll();
  const dupe  = all.find(e => e.idempotencyKey === ikey && e.status !== 'synced');
  if (dupe) {
    devInfo(`[OfflineQueue] Duplicate suppressed: ${action} ikey=${ikey}`);
    return dupe;
  }

  const expiresAt = Date.now() + (opts.maxAgeMs || OFFLINE_MAX_AGE_MS);
  const signature = await signOfflinePayload(action, payload, ikey, expiresAt);
  const entry = makeEntry(action, payload, opts.priority, ikey, signature, expiresAt);
  await dbPut(entry);
  devInfo(`[OfflineQueue] Enqueued: ${action}`, { actionId: entry.actionId, ikey });
  emit('PAYMENT_CREATED', { queued: true, action, actionId: entry.actionId });
  return entry;
}

/**
 * Sync all pending actions. Skips entries whose nextRetryAt is in the future.
 * Processes in priority descending order.
 *
 * @param {object} opts
 * @param {number} [opts.maxPriority=Infinity] - Only process actions at or below
 *   this priority. Pass `ACTION_PRIORITY.ACCOUNT` to skip FINANCIAL items on
 *   auto-reconnect (those require explicit step-up via a direct call).
 */
export async function syncPendingActions({ maxPriority = Infinity } = {}) {
  const quality = await detectConnectionQualityAsync();
  if (quality === CONNECTION_QUALITY.OFFLINE) {
    devInfo('[OfflineQueue] Still offline - skipping sync');
    return { synced: 0, failed: 0, skipped: 0 };
  }

  const all     = await dbGetAll();
  const now     = Date.now();
  const pending = all
    .filter(a =>
      (a.status === 'pending' || a.status === 'failed') &&
      a.retries < MAX_RETRIES &&
      (a.nextRetryAt || 0) <= now &&
      (a.priority || 0) <= maxPriority
    )
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));

  let synced = 0, failed = 0, skipped = 0;

  for (const action of pending) {
    const handler = _actionHandlers[action.action];
    if (!handler) {
      action.status    = 'failed';
      action.lastError = `No handler: ${action.action}`;
      await dbPut(action);
      failed++;
      continue;
    }

    const replaySafety = await validateOfflineEntry(action);
    if (!replaySafety.valid) {
      action.status = replaySafety.reason === 'offline_replay_duplicate' ? 'synced' : 'dead';
      action.lastError = replaySafety.reason;
      action.syncedAt = replaySafety.reason === 'offline_replay_duplicate' ? Date.now() : action.syncedAt;
      await dbPut(action);
      skipped++;
      emit('OFFLINE_REPLAY_REJECTED', {
        actionId: action.actionId,
        reason: replaySafety.reason,
        idempotencyKey: action.idempotencyKey,
      });
      continue;
    }

    action.status = 'syncing';
    await dbPut(action);

    try {
      await handler(action.payload);
      action.status   = 'synced';
      action.syncedAt = Date.now();
      markOfflineReplayComplete(action);
      await dbPut(action);
      synced++;
      emit('PAYMENT_SETTLED', { actionId: action.actionId, action: action.action });
    } catch (err) {
      action.retries++;
      action.status      = action.retries >= MAX_RETRIES ? 'dead' : 'failed';
      action.lastError   = err?.message || String(err);
      action.nextRetryAt = Date.now() + calcBackoffMs(action.retries);
      await dbPut(action);
      failed++;
      emit('PAYMENT_FAILED', { actionId: action.actionId, error: action.lastError, retries: action.retries });
      devWarn(`[OfflineQueue] Failed (retry ${action.retries}/${MAX_RETRIES}) - backoff ${action.nextRetryAt - Date.now()}ms`, action.lastError);
    }
  }

  // Prune synced entries older than 7 days
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const entry of all) {
    if (entry.status === 'synced' && entry.syncedAt < cutoff) {
      await dbDelete(entry.actionId);
    }
  }

  devInfo(`[OfflineQueue] Sync - synced:${synced} failed:${failed} skipped:${skipped}`);
  return { synced, failed, skipped };
}

/**
 * Get a summary of the offline queue status (synchronous snapshot).
 */
export function getQueueStatus() {
  const q = lsReadQueue(); // sync snapshot for UI
  return {
    pending: q.filter(a => a.status === 'pending').length,
    syncing: q.filter(a => a.status === 'syncing').length,
    synced:  q.filter(a => a.status === 'synced').length,
    failed:  q.filter(a => a.status === 'failed').length,
    dead:    q.filter(a => a.status === 'dead').length,
    total:   q.length,
    quality: detectConnectionQuality(),
    lowData: isLowDataMode(),
  };
}

export function getPendingActions() {
  return lsReadQueue().filter(a => a.status === 'pending' || a.status === 'failed');
}

// ── Connectivity monitor ──────────────────────────────────────────────────────

let _monitorInterval = null;

/**
 * Start adaptive polling for connection quality changes.
 * Poll frequency adapts to quality — poor connection polls less aggressively.
 */
export function startConnectivityMonitor(onQualityChange) {
  let lastQuality = detectConnectionQuality();

  async function check() {
    const q = await detectConnectionQualityAsync();
    if (q !== lastQuality) {
      lastQuality = q;
      onQualityChange?.(q);
      emit('NETWORK_QUALITY_CHANGED', { quality: q });
    }
    // Adaptive poll interval
    const intervalMs = q === CONNECTION_QUALITY.POOR ? 8000 : q === CONNECTION_QUALITY.FAIR ? 5000 : 12000;
    clearTimeout(_monitorInterval);
    _monitorInterval = setTimeout(check, intervalMs);
  }

  check();
  return () => clearTimeout(_monitorInterval);
}

// ── Auto-init ─────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  let wasOffline = !navigator.onLine;

  window.addEventListener('online', async () => {
    if (wasOffline) {
      wasOffline = false;
      devInfo('[OfflineQueue] Connection restored');
      _reconnectHooks.forEach(h => { try { h(); } catch {} });
      // Small delay to let the connection stabilise before syncing
      await new Promise(r => setTimeout(r, 1200));
      // Financial-priority items must NOT auto-execute on reconnect — they
      // require explicit server re-authentication / step-up from the UI.
      // Auto-sync only ACCOUNT and analytics actions; emit an event so the
      // UI can surface a step-up prompt for pending financial items.
      const snapshot = lsReadQueue();
      const financialPending = snapshot.filter(
        e => (e.status === 'pending' || e.status === 'failed') &&
             (e.priority || 0) >= ACTION_PRIORITY.FINANCIAL
      );
      if (financialPending.length > 0) {
        emit('OFFLINE_FINANCIAL_PENDING_STEP_UP', { count: financialPending.length });
        devInfo(`[OfflineQueue] ${financialPending.length} financial item(s) held — step-up required`);
      }
      await syncPendingActions({ maxPriority: ACTION_PRIORITY.ACCOUNT });
      emit('NETWORK_RECONNECTED', { hasFinancialPending: financialPending.length > 0 });
    }
  });

  window.addEventListener('offline', () => {
    wasOffline = true;
    emit('NETWORK_DISCONNECTED', {});
    devWarn('[OfflineQueue] Connection lost');
  });

  // Sync on Network Information API change (catches weak→strong without full offline)
  // Same financial guard applies — FINANCIAL items are never auto-synced.
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    conn.addEventListener('change', async () => {
      const q = detectConnectionQuality();
      emit('NETWORK_QUALITY_CHANGED', { quality: q });
      if (q !== CONNECTION_QUALITY.OFFLINE && q !== CONNECTION_QUALITY.POOR) {
        await syncPendingActions({ maxPriority: ACTION_PRIORITY.ACCOUNT });
      }
    });
  }
}
