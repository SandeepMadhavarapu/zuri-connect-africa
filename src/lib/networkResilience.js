/**
 * Network Resilience — telecom-grade connectivity management for Zuri Connect Africa.
 *
 * Addresses realities of African mobile networks:
 *   • 3G/LTE toggling mid-session (GPRS fallback, tower handover)
 *   • Asymmetric latency spikes (uplink congestion)
 *   • Reconnect storms (hundreds of devices reconnecting simultaneously after outage)
 *   • USSD session timeout (180s hard limit)
 *   • STK push delivery failures on busy networks
 *
 * Features:
 *   • Multi-probe RTT measurement (avoids single-probe false positives)
 *   • Adaptive quality tiers: EXCELLENT / GOOD / DEGRADED / POOR / OFFLINE
 *   • Reconnect storm mitigation via jittered exponential backoff
 *   • Request timeout budgets per quality tier
 *   • Graceful degradation hooks (callers register callbacks per tier)
 *   • Persisted offline action queue (delegates to offlineQueue.js)
 *
 * Extends (does not replace) src/lib/offlineQueue.js.
 */

// ── Quality tiers ─────────────────────────────────────────────────────────────

export const QUALITY = Object.freeze({
  EXCELLENT: 'EXCELLENT',   // RTT < 100ms
  GOOD:      'GOOD',        // RTT 100-300ms
  DEGRADED:  'DEGRADED',    // RTT 300-800ms
  POOR:      'POOR',        // RTT 800-3000ms
  OFFLINE:   'OFFLINE',     // No connectivity
});

// Timeout budgets (ms) per tier for API calls
export const TIMEOUT_BUDGETS = Object.freeze({
  EXCELLENT:  8_000,
  GOOD:       15_000,
  DEGRADED:   30_000,
  POOR:       60_000,
  OFFLINE:    0,
});

// Retry limits per tier
export const RETRY_LIMITS = Object.freeze({
  EXCELLENT: 3,
  GOOD:      3,
  DEGRADED:  2,
  POOR:      1,
  OFFLINE:   0,
});

// ── Internal state ─────────────────────────────────────────────────────────────

let _currentQuality = QUALITY.GOOD;
let _rttHistory     = [];    // rolling window of last 10 RTT samples (ms)
let _monitorTimer   = null;
let _consecutiveFails = 0;
let _consecutiveSuccess = 0;
const _callbacks    = new Map();  // Map<QUALITY tier | 'any', Set<Function>>

// ── Probe configuration ───────────────────────────────────────────────────────

const PROBE_URLS = [
  // Use tiny no-op images or known-fast CDN endpoints
  // Prefer manifest.json / favicon.ico on same origin to avoid CORS
  typeof window !== 'undefined' ? `${window.location.origin}/favicon.ico` : null,
  'https://www.gstatic.com/generate_204',
].filter(Boolean);

const PROBE_TIMEOUT_MS    = 5000;
const PROBE_INTERVAL_MS   = 15_000;  // check every 15s
const MULTI_PROBE_COUNT   = 2;       // probe 2 URLs, take median RTT
const RTT_HISTORY_SIZE    = 10;

// ── RTT measurement ────────────────────────────────────────────────────────────

async function probeURL(url) {
  const controller = new AbortController();
  const tid        = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const t0         = performance.now();
  try {
    await fetch(url, {
      method: 'HEAD',
      cache:  'no-store',
      signal: controller.signal,
      mode:   'no-cors',   // avoids CORS failures on cross-origin probes
    });
    clearTimeout(tid);
    return Math.round(performance.now() - t0);
  } catch {
    clearTimeout(tid);
    return null;  // null = unreachable
  }
}

async function measureRTT() {
  const urls    = PROBE_URLS.slice(0, MULTI_PROBE_COUNT);
  const results = await Promise.all(urls.map(probeURL));
  const valid   = results.filter(r => r !== null);
  if (valid.length === 0) return null;  // all probes failed = offline
  return Math.round(valid.reduce((a, b) => a + b, 0) / valid.length);
}

// ── Quality classification ─────────────────────────────────────────────────────

function classifyRTT(rtt) {
  if (rtt === null)  return QUALITY.OFFLINE;
  if (rtt < 100)     return QUALITY.EXCELLENT;
  if (rtt < 300)     return QUALITY.GOOD;
  if (rtt < 800)     return QUALITY.DEGRADED;
  return QUALITY.POOR;
}

function medianRTT(history) {
  if (!history.length) return null;
  const sorted = [...history].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

// ── Quality update & notification ─────────────────────────────────────────────

function setQuality(newQuality) {
  const prev = _currentQuality;
  _currentQuality = newQuality;

  if (prev !== newQuality) {
    _notifyCallbacks('any', { from: prev, to: newQuality, rttHistory: [..._rttHistory] });
    _notifyCallbacks(newQuality, { from: prev, to: newQuality, rttHistory: [..._rttHistory] });
  }
}

function _notifyCallbacks(key, payload) {
  const cbs = _callbacks.get(key);
  if (!cbs) return;
  for (const cb of cbs) {
    try { cb(payload); } catch {}
  }
}

// ── Monitor loop ───────────────────────────────────────────────────────────────

async function _runProbe() {
  const rtt = await measureRTT();

  if (rtt === null) {
    _consecutiveFails++;
    _consecutiveSuccess = 0;
    // Only declare OFFLINE after 2 consecutive failures (avoids transient blip)
    if (_consecutiveFails >= 2) setQuality(QUALITY.OFFLINE);
  } else {
    _consecutiveFails  = 0;
    _consecutiveSuccess++;

    // Update rolling RTT history
    _rttHistory.push(rtt);
    if (_rttHistory.length > RTT_HISTORY_SIZE) _rttHistory.shift();

    const median = medianRTT(_rttHistory);
    setQuality(classifyRTT(median));
  }
}

/**
 * Start the periodic network quality monitor.
 * Safe to call multiple times — only one monitor runs at a time.
 *
 * @param {number} [intervalMs]  — probe interval (default 15s)
 */
export function startNetworkMonitor(intervalMs = PROBE_INTERVAL_MS) {
  if (_monitorTimer) return;

  // Run immediately, then on interval
  _runProbe().catch(() => {});
  _monitorTimer = setInterval(() => {
    _runProbe().catch(() => {});
  }, intervalMs);

  // Also hook browser online/offline events for instant reaction
  if (typeof window !== 'undefined') {
    window.addEventListener('online',  _onBrowserOnline,  { passive: true });
    window.addEventListener('offline', _onBrowserOffline, { passive: true });
  }
}

export function stopNetworkMonitor() {
  if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }
  if (typeof window !== 'undefined') {
    window.removeEventListener('online',  _onBrowserOnline);
    window.removeEventListener('offline', _onBrowserOffline);
  }
}

function _onBrowserOnline() {
  // Re-probe immediately on browser "online" signal — it's often optimistic
  _consecutiveFails = 0;
  _runProbe().catch(() => {});
}

function _onBrowserOffline() {
  _consecutiveFails  = 3;  // Fast-track to OFFLINE
  _consecutiveSuccess = 0;
  setQuality(QUALITY.OFFLINE);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/** Current connection quality tier. */
export function getQuality()    { return _currentQuality; }

/** Latest RTT history (array of ms values). */
export function getRTTHistory() { return [..._rttHistory]; }

/** Median RTT from history, or null if no samples. */
export function getMedianRTT()  { return medianRTT(_rttHistory); }

/** True if current quality is OFFLINE. */
export function isOffline()     { return _currentQuality === QUALITY.OFFLINE; }

/** True if current quality is POOR or OFFLINE. */
export function isPoorConnection() {
  return _currentQuality === QUALITY.POOR || _currentQuality === QUALITY.OFFLINE;
}

/**
 * Returns the recommended API request timeout for the current connection quality.
 */
export function getTimeoutBudget() {
  return TIMEOUT_BUDGETS[_currentQuality] ?? TIMEOUT_BUDGETS.GOOD;
}

/**
 * Returns the recommended retry limit for the current connection quality.
 */
export function getRetryLimit() {
  return RETRY_LIMITS[_currentQuality] ?? RETRY_LIMITS.GOOD;
}

/**
 * Register a callback for quality changes.
 *
 * @param {string|'any'}  tier      — QUALITY tier or 'any' for all changes
 * @param {Function}      callback  — ({ from, to, rttHistory }) => void
 * @returns {Function} unsubscribe
 */
export function onQualityChange(tier, callback) {
  if (!_callbacks.has(tier)) _callbacks.set(tier, new Set());
  _callbacks.get(tier).add(callback);
  return () => _callbacks.get(tier)?.delete(callback);
}

// ── Reconnect-storm-safe retry helper ─────────────────────────────────────────

/**
 * Retry an async operation with:
 *   • Quality-aware timeout budget
 *   • Exponential backoff with ±30% jitter (prevents reconnect storms)
 *   • Automatic abort if quality drops to OFFLINE mid-retry
 *
 * @param {Function} operation   — async () => result
 * @param {object}   [opts]
 * @param {number}   [opts.maxAttempts]   — overrides quality-derived limit
 * @param {number}   [opts.baseDelayMs]   — default 500ms
 * @param {number}   [opts.maxDelayMs]    — default 30s
 * @param {string}   [opts.label]         — for logging
 * @returns {Promise<any>}
 */
export async function resilientRetry(operation, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? getRetryLimit();
  const baseDelay   = opts.baseDelayMs  ?? 500;
  const maxDelay    = opts.maxDelayMs   ?? 30_000;

  let lastError;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (isOffline()) {
      throw new Error('network_offline');
    }

    try {
      const timeout  = getTimeoutBudget();
      const result   = timeout > 0
        ? await withTimeout(operation(), timeout)
        : await operation();
      return result;
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;

      // Jittered exponential backoff
      const baseMs  = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
      const jitter  = baseMs * 0.3 * (Math.random() * 2 - 1); // ±30%
      const delayMs = Math.round(Math.max(100, baseMs + jitter));
      await sleep(delayMs);
    }
  }

  throw lastError;
}

/**
 * Wrap a promise with a hard timeout.
 *
 * @param {Promise<any>} promise
 * @param {number}       timeoutMs
 */
export function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error(`request_timeout_${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (v) => { clearTimeout(tid); resolve(v); },
      (e) => { clearTimeout(tid); reject(e);  }
    );
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── USSD session timer ─────────────────────────────────────────────────────────

const USSD_TIMEOUT_MS = 175_000;  // 175s — 5s before carrier hard-cut at 180s

/**
 * Creates a USSD session timeout guard.
 * Calls onWarning at 120s, onExpiry at 175s.
 *
 * @param {Function} onWarning   — called at 120s
 * @param {Function} onExpiry    — called at 175s (session about to be killed by carrier)
 * @returns {{ cancel: Function }}
 */
export function createUSSDSessionTimer(onWarning, onExpiry) {
  const warnTimer   = setTimeout(() => { try { onWarning?.(); } catch {} }, 120_000);
  const expiryTimer = setTimeout(() => { try { onExpiry?.();  } catch {} }, USSD_TIMEOUT_MS);
  return {
    cancel: () => { clearTimeout(warnTimer); clearTimeout(expiryTimer); },
  };
}

// ── STK push delivery helper ──────────────────────────────────────────────────

const STK_TIMEOUT_MS       = 90_000;  // 90s — standard M-PESA STK push window
const STK_POLL_INTERVAL_MS = 3_000;

/**
 * Poll for STK push status until confirmed, timed out, or cancelled.
 *
 * @param {Function} checkFn         — async () => 'pending'|'confirmed'|'failed'|'cancelled'
 * @param {Function} onConfirmed     — called when status = 'confirmed'
 * @param {Function} onFailed        — called when status = 'failed' or 'cancelled'
 * @param {Function} onTimeout       — called when STK_TIMEOUT_MS elapses without confirmation
 * @returns {{ cancel: Function }}
 */
export function pollSTKPush(checkFn, onConfirmed, onFailed, onTimeout) {
  let cancelled  = false;
  let intervalId = null;

  const timeoutId = setTimeout(() => {
    cancelled = true;
    clearInterval(intervalId);
    try { onTimeout?.(); } catch {}
  }, STK_TIMEOUT_MS);

  intervalId = setInterval(async () => {
    if (cancelled) return;
    try {
      const status = await checkFn();
      if (status === 'confirmed') {
        cancelled = true;
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        try { onConfirmed?.(); } catch {}
      } else if (status === 'failed' || status === 'cancelled') {
        cancelled = true;
        clearInterval(intervalId);
        clearTimeout(timeoutId);
        try { onFailed?.(status); } catch {}
      }
    } catch {}
  }, STK_POLL_INTERVAL_MS);

  return {
    cancel: () => {
      cancelled = true;
      clearInterval(intervalId);
      clearTimeout(timeoutId);
    },
  };
}

// ── Auto-start on import ───────────────────────────────────────────────────────

// Initialise quality from navigator.onLine before the first probe completes
if (typeof navigator !== 'undefined' && navigator.onLine === false) {
  _currentQuality = QUALITY.OFFLINE;
}

startNetworkMonitor();
