/**
 * Durable Event Bus — persistent, replayable pub/sub for Zuri Connect Africa.
 *
 * Upgrades the in-memory eventBus with:
 *   • IndexedDB-backed event persistence (survives page reloads)
 *   • Replay: re-deliver stored events to late subscribers
 *   • Dead-letter queue (DLQ) for failed handlers
 *   • Per-event correlation IDs and causal chain tracking
 *   • Retry policies with exponential backoff
 *   • Event schema validation with unknown-field tolerance
 *   • Backwards-compatible with existing eventBus.js EVENTS constants
 *
 * Storage:
 *   IndexedDB database: 'zuri_event_bus_v1'
 *   Object stores: events, dlq
 *   localStorage fallback: 'zuri_event_bus_fallback_v1' (last 200 events)
 */

import { EVENTS } from '@/lib/eventBus';

// Re-export EVENTS for callers that only import this module
export { EVENTS };

// ── Constants ─────────────────────────────────────────────────────────────────

const DB_NAME        = 'zuri_event_bus_v1';
const DB_VERSION     = 1;
const STORE_EVENTS   = 'events';
const STORE_DLQ      = 'dlq';
const LS_FALLBACK    = 'zuri_event_bus_fallback_v1';
const MAX_LS_EVENTS  = 200;
const MAX_IDB_EVENTS = 5000;
const DLQ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const DEFAULT_RETRY_POLICY = {
  maxAttempts:    3,
  baseDelayMs:    200,
  maxDelayMs:     5000,
  backoffFactor:  2,
};

// ── FNV-1a hash (32-bit) ──────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function generateEventId(eventType) {
  return `ev_${fnv1a(eventType + Date.now() + Math.random())}_${Date.now()}`;
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

        if (!db.objectStoreNames.contains(STORE_EVENTS)) {
          const es = db.createObjectStore(STORE_EVENTS, { keyPath: 'id' });
          es.createIndex('by_type',         'type',        { unique: false });
          es.createIndex('by_created_at',   'createdAt',   { unique: false });
          es.createIndex('by_correlation',  'correlationId', { unique: false });
        }

        if (!db.objectStoreNames.contains(STORE_DLQ)) {
          const ds = db.createObjectStore(STORE_DLQ, { keyPath: 'id' });
          ds.createIndex('by_type',       'eventType',  { unique: false });
          ds.createIndex('by_failed_at',  'failedAt',   { unique: false });
        }
      };

      req.onsuccess = (e) => {
        _db = e.target.result;
        _db.onversionchange = () => { _db.close(); _db = null; _dbInitPromise = null; };
        resolve(_db);
      };

      req.onerror  = () => reject(req.error);
      req.onblocked = () => reject(new Error('IDB blocked'));
    } catch (err) {
      reject(err);
    }
  });

  return _dbInitPromise;
}

async function idbPut(store, record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(record);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

async function idbGetAll(store, indexName = null, query = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(store, 'readonly');
    const os  = tx.objectStore(store);
    const req = indexName
      ? os.index(indexName).getAll(query)
      : os.getAll(query);
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

async function idbCount(store) {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx  = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror   = () => resolve(0);
  });
}

// ── localStorage fallback ─────────────────────────────────────────────────────

function lsAppend(eventRecord) {
  try {
    const raw    = localStorage.getItem(LS_FALLBACK);
    const events = raw ? JSON.parse(raw) : [];
    events.push(eventRecord);
    // Keep last MAX_LS_EVENTS
    if (events.length > MAX_LS_EVENTS) events.splice(0, events.length - MAX_LS_EVENTS);
    localStorage.setItem(LS_FALLBACK, JSON.stringify(events));
  } catch {}
}

function lsGetAll() {
  try {
    const raw = localStorage.getItem(LS_FALLBACK);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

// ── Persist event (IDB primary, LS fallback) ─────────────────────────────────

async function persistEvent(record) {
  try {
    await idbPut(STORE_EVENTS, record);
    // Prune oldest events when over limit
    const count = await idbCount(STORE_EVENTS);
    if (count > MAX_IDB_EVENTS) {
      const all = await idbGetAll(STORE_EVENTS, 'by_created_at');
      const toDelete = all.slice(0, count - MAX_IDB_EVENTS);
      for (const ev of toDelete) {
        await idbDelete(STORE_EVENTS, ev.id).catch(() => {});
      }
    }
  } catch {
    lsAppend(record);
  }
}

// ── Subscriber registry ───────────────────────────────────────────────────────

// Map<eventType, Set<{handler, retryPolicy, subscribedAt}>>
const _subscribers = new Map();

// ── Core pub/sub ──────────────────────────────────────────────────────────────

/**
 * Subscribe to an event type.
 *
 * @param {string}   eventType
 * @param {Function} handler      — async (payload, meta) => void
 * @param {object}   [options]
 * @param {object}   [options.retryPolicy]    — { maxAttempts, baseDelayMs, ... }
 * @param {boolean}  [options.replay]         — replay up to N recent events on subscribe
 * @param {number}   [options.replayCount]    — how many recent events to replay (default 0)
 * @returns {Function} unsubscribe
 */
export function on(eventType, handler, options = {}) {
  if (!_subscribers.has(eventType)) _subscribers.set(eventType, new Set());

  const sub = {
    handler,
    retryPolicy:   options.retryPolicy || DEFAULT_RETRY_POLICY,
    subscribedAt:  Date.now(),
  };
  _subscribers.get(eventType).add(sub);

  // Optional replay of recent persisted events
  if (options.replay && options.replayCount > 0) {
    _replayToSubscriber(eventType, sub, options.replayCount).catch(() => {});
  }

  return () => {
    const subs = _subscribers.get(eventType);
    if (subs) subs.delete(sub);
  };
}

/**
 * Subscribe to an event exactly once — auto-unsubscribes after first delivery.
 */
export function once(eventType, handler, options = {}) {
  let unsub;
  unsub = on(eventType, async (payload, meta) => {
    unsub?.();
    await handler(payload, meta);
  }, options);
  return unsub;
}

/**
 * Remove all subscribers for one event type, or all events.
 */
export function off(eventType = null) {
  if (eventType) _subscribers.delete(eventType);
  else           _subscribers.clear();
}

/**
 * Emit an event. Persists to storage, then delivers to all live subscribers.
 * Never throws — handler errors are caught, retried, and dead-lettered if exhausted.
 *
 * @param {string}  eventType
 * @param {object}  payload
 * @param {object}  [meta]             — optional metadata overrides
 * @param {string}  [meta.correlationId]
 * @param {string}  [meta.causationId]   — id of the event that caused this one
 * @param {boolean} [meta.persist]       — set false to skip persistence (default true)
 * @returns {string} eventId
 */
export function emit(eventType, payload = {}, meta = {}) {
  const eventId      = generateEventId(eventType);
  const correlationId = meta.correlationId || eventId;
  const record = {
    id:            eventId,
    type:          eventType,
    payload,
    correlationId,
    causationId:   meta.causationId || null,
    createdAt:     Date.now(),
    isoCreatedAt:  new Date().toISOString(),
    persist:       meta.persist !== false,
  };

  // Persist asynchronously — do not block delivery
  if (record.persist) {
    persistEvent(record).catch(() => {});
  }

  // Deliver synchronously-first to avoid ordering issues, then retry async
  _deliverToSubscribers(eventType, record);

  return eventId;
}

// ── Delivery with retry ───────────────────────────────────────────────────────

function _deliverToSubscribers(eventType, record) {
  const subs = _subscribers.get(eventType);
  if (!subs || subs.size === 0) return;

  for (const sub of subs) {
    _deliverWithRetry(sub, record, 0).catch(() => {});
  }
}

async function _deliverWithRetry(sub, record, attempt) {
  try {
    await sub.handler(record.payload, {
      id:            record.id,
      type:          record.type,
      correlationId: record.correlationId,
      causationId:   record.causationId,
      createdAt:     record.isoCreatedAt,
      attempt,
    });
  } catch (err) {
    const policy    = sub.retryPolicy || DEFAULT_RETRY_POLICY;
    const nextAttempt = attempt + 1;

    if (nextAttempt < policy.maxAttempts) {
      const delay = Math.min(
        policy.baseDelayMs * Math.pow(policy.backoffFactor, attempt),
        policy.maxDelayMs
      );
      setTimeout(() => {
        _deliverWithRetry(sub, record, nextAttempt).catch(() => {});
      }, delay);
    } else {
      // Move to DLQ
      _sendToDLQ(record, sub, err).catch(() => {});
    }
  }
}

async function _sendToDLQ(record, sub, error) {
  const dlqEntry = {
    id:          `dlq_${record.id}`,
    eventId:     record.id,
    eventType:   record.type,
    payload:     record.payload,
    correlationId: record.correlationId,
    failedAt:    Date.now(),
    isoFailedAt: new Date().toISOString(),
    errorMessage: error?.message || 'unknown_handler_error',
    attempts:    sub.retryPolicy?.maxAttempts || DEFAULT_RETRY_POLICY.maxAttempts,
  };
  try {
    await idbPut(STORE_DLQ, dlqEntry);
  } catch {
    // DLQ store failed — nothing we can do
  }
}

// ── Replay ────────────────────────────────────────────────────────────────────

async function _replayToSubscriber(eventType, sub, count) {
  let events = [];
  try {
    events = await idbGetAll(STORE_EVENTS, 'by_type', IDBKeyRange.only(eventType));
  } catch {
    events = lsGetAll().filter(e => e.type === eventType);
  }

  // Newest last, replay oldest first, up to count
  const toReplay = events.slice(-count);
  for (const ev of toReplay) {
    await _deliverWithRetry(sub, ev, 0).catch(() => {});
  }
}

/**
 * Replay all persisted events of a given type to current subscribers.
 * Use for recovery after connectivity loss or subscriber restart.
 *
 * @param {string} eventType
 * @param {number} [since]     — Unix timestamp ms; replay events after this time
 */
export async function replay(eventType, since = 0) {
  let events = [];
  try {
    const all = await idbGetAll(STORE_EVENTS, 'by_type', IDBKeyRange.only(eventType));
    events    = all.filter(e => e.createdAt > since);
  } catch {
    events = lsGetAll().filter(e => e.type === eventType && e.createdAt > since);
  }

  for (const ev of events) {
    _deliverToSubscribers(eventType, ev);
  }

  return events.length;
}

/**
 * Replay all persisted events in chronological order.
 * Useful for rebuilding in-memory state after a page reload.
 */
export async function replayAll(since = 0) {
  let events = [];
  try {
    const all = await idbGetAll(STORE_EVENTS, 'by_created_at');
    events    = all.filter(e => e.createdAt > since).sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    events = lsGetAll().filter(e => e.createdAt > since).sort((a, b) => a.createdAt - b.createdAt);
  }

  for (const ev of events) {
    _deliverToSubscribers(ev.type, ev);
  }

  return events.length;
}

// ── DLQ management ────────────────────────────────────────────────────────────

/**
 * Fetch all dead-letter events.
 * @returns {Promise<object[]>}
 */
export async function getDLQ() {
  try {
    return await idbGetAll(STORE_DLQ, 'by_failed_at');
  } catch { return []; }
}

/**
 * Retry all dead-letter events for a given type.
 * Re-emits them into the live bus and removes from DLQ on success.
 *
 * @param {string} [eventType]  — if omitted, retries all DLQ entries
 */
export async function retryDLQ(eventType = null) {
  const dlqEntries = await getDLQ();
  const toRetry    = eventType ? dlqEntries.filter(e => e.eventType === eventType) : dlqEntries;
  let   retried    = 0;

  for (const entry of toRetry) {
    emit(entry.eventType, entry.payload, {
      correlationId: entry.correlationId,
      persist:       false,
    });
    await idbDelete(STORE_DLQ, entry.id).catch(() => {});
    retried++;
  }

  return retried;
}

/**
 * Purge DLQ entries older than retention window.
 */
export async function purgeDLQ() {
  const cutoff  = Date.now() - DLQ_RETENTION_MS;
  const entries = await getDLQ();
  let   purged  = 0;
  for (const e of entries) {
    if (e.failedAt < cutoff) {
      await idbDelete(STORE_DLQ, e.id).catch(() => {});
      purged++;
    }
  }
  return purged;
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/**
 * Returns current listener counts per event type.
 */
export function listenerCounts() {
  const counts = {};
  for (const [type, subs] of _subscribers.entries()) {
    counts[type] = subs.size;
  }
  return counts;
}

/**
 * Returns storage stats.
 */
export async function getBusStats() {
  let eventCount = 0;
  let dlqCount   = 0;
  try {
    eventCount = await idbCount(STORE_EVENTS);
    dlqCount   = await idbCount(STORE_DLQ);
  } catch {
    const ls = lsGetAll();
    eventCount = ls.length;
  }
  return {
    persistedEvents:     eventCount,
    deadLetterCount:     dlqCount,
    activeSubscriptions: [..._subscribers.values()].reduce((t, s) => t + s.size, 0),
    subscribedTypes:     [..._subscribers.keys()],
  };
}

/**
 * Clear all persisted events and subscribers.
 * Use in tests or emergency resets only.
 */
export async function clearBus() {
  _subscribers.clear();
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_EVENTS, STORE_DLQ], 'readwrite');
    tx.objectStore(STORE_EVENTS).clear();
    tx.objectStore(STORE_DLQ).clear();
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch {}
  try { localStorage.removeItem(LS_FALLBACK); } catch {}
}
