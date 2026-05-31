/**
 * Telemetry Service — telecom-grade observability for Zuri Connect Africa.
 *
 * Implements a structured metrics + tracing pipeline modelled on:
 *   • OpenTelemetry semantic conventions (spans, attributes)
 *   • RED method (Rate, Errors, Duration) per service
 *   • USE method (Utilization, Saturation, Errors) for infrastructure signals
 *   • SLO/SLI tracking with error-budget burn rate alerts
 *
 * Storage:
 *   localStorage 'zuri_telemetry_v1' — rolling 1-hour metric snapshots
 *   localStorage 'zuri_traces_v1'    — last 500 distributed trace spans
 *   sessionStorage 'zuri_slo_v1'     — current-session SLO counters
 *
 * All writes are non-blocking and never throw.
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_METRICS   = 'zuri_telemetry_v1';
const LS_TRACES    = 'zuri_traces_v1';
const SS_SLO       = 'zuri_slo_v1';
const MAX_SPANS    = 500;
const MAX_SNAPSHOTS = 60;   // 60 one-minute buckets = 1 hour of history

// Service names
export const SERVICES = Object.freeze({
  PAYMENTS:       'payments',
  AUTH:           'auth',
  LEDGER:         'ledger',
  FRAUD:          'fraud',
  POLICY_ENGINE:  'policy_engine',
  SETTLEMENT:     'settlement',
  RECONCILIATION: 'reconciliation',
  WEBHOOK:        'webhook',
  QUEUE:          'queue',
  NOTIFICATIONS:  'notifications',
  NETWORK:        'network',
  AI:             'ai',
});

// SLO targets
const SLO_TARGETS = {
  [SERVICES.PAYMENTS]:       { availabilityPct: 99.9, latencyP99Ms: 3000 },
  [SERVICES.AUTH]:           { availabilityPct: 99.99, latencyP99Ms: 1000 },
  [SERVICES.LEDGER]:         { availabilityPct: 99.99, latencyP99Ms: 500  },
  [SERVICES.FRAUD]:          { availabilityPct: 99.5,  latencyP99Ms: 500  },
  [SERVICES.POLICY_ENGINE]:  { availabilityPct: 99.9,  latencyP99Ms: 200  },
  [SERVICES.SETTLEMENT]:     { availabilityPct: 99.5,  latencyP99Ms: 5000 },
  [SERVICES.RECONCILIATION]: { availabilityPct: 99.0,  latencyP99Ms: 10000},
  [SERVICES.WEBHOOK]:        { availabilityPct: 99.5,  latencyP99Ms: 2000 },
  [SERVICES.QUEUE]:          { availabilityPct: 99.9,  latencyP99Ms: 1000 },
};

// ── FNV-1a ────────────────────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function genTraceId() {
  return fnv1a(Math.random().toString() + Date.now()) +
         fnv1a(performance.now().toString() + Math.random());
}

function genSpanId() {
  return fnv1a(Math.random().toString() + Date.now()).slice(0, 8);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function safeLS(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}

function savLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function savSS(key, val) {
  try { sessionStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function safeSS(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; }
}

// ── Metric store ──────────────────────────────────────────────────────────────

function loadMetrics() {
  return safeLS(LS_METRICS) || {};
}

function saveMetrics(metrics) {
  savLS(LS_METRICS, metrics);
}

function getServiceMetrics(service) {
  const all = loadMetrics();
  if (!all[service]) {
    all[service] = {
      requestCount:    0,
      errorCount:      0,
      latencySamples:  [],   // rolling last 100
      p50:             0,
      p95:             0,
      p99:             0,
      lastUpdated:     null,
      snapshots:       [],   // per-minute rate snapshots
    };
  }
  return { all, svc: all[service] };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Core recording ─────────────────────────────────────────────────────────────

/**
 * Record a service operation (request + latency + success/failure).
 *
 * @param {string}  service      — SERVICES constant
 * @param {string}  operation    — operation name (e.g. 'sendMoney', 'evaluatePolicy')
 * @param {number}  latencyMs    — duration of the operation
 * @param {boolean} success      — whether it succeeded
 * @param {object}  [attrs]      — optional key/value attributes (stored in spans)
 */
export function recordOperation(service, operation, latencyMs, success, attrs = {}) {
  try {
    const { all, svc } = getServiceMetrics(service);
    svc.requestCount++;
    if (!success) svc.errorCount++;

    // Rolling latency window
    svc.latencySamples.push(latencyMs);
    if (svc.latencySamples.length > 100) svc.latencySamples.shift();

    const sorted = [...svc.latencySamples].sort((a, b) => a - b);
    svc.p50 = percentile(sorted, 50);
    svc.p95 = percentile(sorted, 95);
    svc.p99 = percentile(sorted, 99);

    // Per-minute snapshot
    const nowMin = Math.floor(Date.now() / 60_000);
    const lastSnap = svc.snapshots[svc.snapshots.length - 1];
    if (!lastSnap || lastSnap.minute !== nowMin) {
      svc.snapshots.push({ minute: nowMin, requests: 1, errors: success ? 0 : 1 });
    } else {
      lastSnap.requests++;
      if (!success) lastSnap.errors++;
    }
    if (svc.snapshots.length > MAX_SNAPSHOTS) svc.snapshots.shift();

    svc.lastUpdated = new Date().toISOString();
    all[service] = svc;
    saveMetrics(all);

    // Update SLO counters
    _recordSLOEvent(service, latencyMs, success);
  } catch {}
}

// ── SLO tracking ──────────────────────────────────────────────────────────────

function _recordSLOEvent(service, latencyMs, success) {
  try {
    const slo = safeSS(SS_SLO) || {};
    if (!slo[service]) {
      slo[service] = { good: 0, total: 0, latencyBreach: 0, sessionStart: Date.now() };
    }
    const s = slo[service];
    s.total++;
    const target = SLO_TARGETS[service];
    if (target) {
      const latencyOk = latencyMs <= target.latencyP99Ms;
      if (success && latencyOk) s.good++;
      if (!latencyOk) s.latencyBreach++;
    } else {
      if (success) s.good++;
    }
    savSS(SS_SLO, slo);
  } catch {}
}

/**
 * Get SLO status for a service.
 *
 * @param {string} service
 * @returns {{ availability: number, errorBudgetRemaining: number, breaching: boolean }}
 */
export function getSLOStatus(service) {
  try {
    const slo    = safeSS(SS_SLO) || {};
    const s      = slo[service];
    const target = SLO_TARGETS[service];

    if (!s || !s.total) return { availability: 100, errorBudgetRemaining: 100, breaching: false };

    const availability        = (s.good / s.total) * 100;
    const targetAvailability  = target?.availabilityPct ?? 99.9;
    const errorBudget         = 100 - targetAvailability;
    const consumed            = 100 - availability;
    const errorBudgetRemaining = Math.max(0, ((errorBudget - consumed) / errorBudget) * 100);

    return {
      availability:          parseFloat(availability.toFixed(4)),
      errorBudgetRemaining:  parseFloat(errorBudgetRemaining.toFixed(2)),
      latencyBreaches:       s.latencyBreach || 0,
      breaching:             availability < targetAvailability,
      target:                targetAvailability,
      sessionRequests:       s.total,
    };
  } catch { return { availability: 100, errorBudgetRemaining: 100, breaching: false }; }
}

/**
 * Get SLO status for all tracked services.
 */
export function getAllSLOStatus() {
  const result = {};
  for (const svc of Object.values(SERVICES)) {
    result[svc] = getSLOStatus(svc);
  }
  return result;
}

// ── Distributed tracing ───────────────────────────────────────────────────────

const _activeSpans = new Map();  // spanId → span

/**
 * Start a trace span.
 *
 * @param {string}  service      — SERVICES constant
 * @param {string}  operation
 * @param {object}  [opts]
 * @param {string}  [opts.traceId]    — inherit from parent span
 * @param {string}  [opts.parentSpanId]
 * @param {object}  [opts.attrs]
 * @returns {{ spanId: string, traceId: string }}
 */
export function startSpan(service, operation, opts = {}) {
  try {
    const spanId  = genSpanId();
    const traceId = opts.traceId || genTraceId();
    const span    = {
      spanId,
      traceId,
      parentSpanId:  opts.parentSpanId || null,
      service,
      operation,
      startMs:       performance.now(),
      startTs:       new Date().toISOString(),
      attrs:         opts.attrs || {},
      status:        'active',
    };
    _activeSpans.set(spanId, span);
    return { spanId, traceId };
  } catch { return { spanId: 'noop', traceId: 'noop' }; }
}

/**
 * End a span and persist it.
 *
 * @param {string}  spanId
 * @param {boolean} [success]
 * @param {object}  [extraAttrs]
 */
export function endSpan(spanId, success = true, extraAttrs = {}) {
  try {
    const span = _activeSpans.get(spanId);
    if (!span) return;
    _activeSpans.delete(spanId);

    const durationMs = Math.round(performance.now() - span.startMs);
    const completed  = {
      ...span,
      durationMs,
      endTs:    new Date().toISOString(),
      success,
      attrs:    { ...span.attrs, ...extraAttrs },
      status:   success ? 'ok' : 'error',
    };

    // Persist span
    const traces = safeLS(LS_TRACES) || [];
    traces.push(completed);
    if (traces.length > MAX_SPANS) traces.splice(0, traces.length - MAX_SPANS);
    savLS(LS_TRACES, traces);

    // Mirror to metrics
    recordOperation(span.service, span.operation, durationMs, success);
  } catch {}
}

/**
 * Convenience wrapper: runs an async function within a span.
 *
 * @template T
 * @param {string}    service
 * @param {string}    operation
 * @param {Function}  fn          — async (spanContext) => T
 * @param {object}    [opts]
 * @returns {Promise<T>}
 */
export async function traced(service, operation, fn, opts = {}) {
  const { spanId, traceId } = startSpan(service, operation, opts);
  try {
    const result = await fn({ spanId, traceId });
    endSpan(spanId, true);
    return result;
  } catch (err) {
    endSpan(spanId, false, { errorMessage: err?.message });
    throw err;
  }
}

// ── Metrics retrieval ─────────────────────────────────────────────────────────

/**
 * Get RED metrics for a service.
 *
 * @param {string} service
 * @returns {{ requestRate, errorRate, p50, p95, p99, requestCount, errorCount }}
 */
export function getServiceMetricsReport(service) {
  try {
    const { svc } = getServiceMetrics(service);

    // Rate = requests in last 5 minutes
    const fiveMinAgo   = Math.floor(Date.now() / 60_000) - 5;
    const recentSnaps  = svc.snapshots.filter(s => s.minute >= fiveMinAgo);
    const recentReqs   = recentSnaps.reduce((a, s) => a + s.requests, 0);
    const recentErrors = recentSnaps.reduce((a, s) => a + s.errors, 0);
    const requestRate  = parseFloat((recentReqs / 5).toFixed(2));  // req/min avg
    const errorRate    = recentReqs > 0
      ? parseFloat(((recentErrors / recentReqs) * 100).toFixed(2))
      : 0;

    return {
      service,
      requestCount:  svc.requestCount,
      errorCount:    svc.errorCount,
      requestRate,
      errorRate,
      p50:           svc.p50,
      p95:           svc.p95,
      p99:           svc.p99,
      lastUpdated:   svc.lastUpdated,
      slo:           getSLOStatus(service),
    };
  } catch {
    return { service, requestCount: 0, errorCount: 0, requestRate: 0, errorRate: 0, p50: 0, p95: 0, p99: 0 };
  }
}

/**
 * Get a full telemetry dashboard report for all services.
 */
export function getTelemetryDashboard() {
  const services  = {};
  for (const svc of Object.values(SERVICES)) {
    services[svc] = getServiceMetricsReport(svc);
  }

  const allSLOs    = getAllSLOStatus();
  const breaching  = Object.entries(allSLOs).filter(([, v]) => v.breaching).map(([k]) => k);

  return {
    generatedAt:    new Date().toISOString(),
    services,
    sloSummary: {
      total:         Object.keys(allSLOs).length,
      breachCount:   breaching.length,
      breaching,
    },
  };
}

/**
 * Get recent trace spans.
 *
 * @param {string} [service]    — filter by service, or all if omitted
 * @param {number} [limit]      — max spans to return (default 50)
 */
export function getRecentSpans(service = null, limit = 50) {
  try {
    const traces = safeLS(LS_TRACES) || [];
    const filtered = service ? traces.filter(s => s.service === service) : traces;
    return filtered.slice(-limit).reverse();
  } catch { return []; }
}

/**
 * Get all spans for a given traceId (distributed trace reconstruction).
 *
 * @param {string} traceId
 */
export function getTrace(traceId) {
  try {
    const traces = safeLS(LS_TRACES) || [];
    return traces
      .filter(s => s.traceId === traceId)
      .sort((a, b) => new Date(a.startTs) - new Date(b.startTs));
  } catch { return []; }
}

/**
 * Reset all telemetry data.
 * Use in tests or on explicit user action.
 */
export function resetTelemetry() {
  try { localStorage.removeItem(LS_METRICS);  } catch {}
  try { localStorage.removeItem(LS_TRACES);   } catch {}
  try { sessionStorage.removeItem(SS_SLO);    } catch {}
}
