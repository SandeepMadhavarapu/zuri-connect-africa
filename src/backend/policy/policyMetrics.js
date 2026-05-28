/**
 * Policy Engine — Metrics, correlation IDs, and observability.
 *
 * Tracks per-policy trigger frequency, engine-level throughput, latency
 * distributions, and action distribution. Integrates with the existing
 * observability platform via obs.track() where appropriate.
 */

const POLICY_METRICS_KEY   = 'zuri_policy_metrics_v1';
const MAX_LATENCY_SAMPLES  = 100;

// ── Storage ────────────────────────────────────────────────────────────────────

function loadMetrics() {
  try {
    return JSON.parse(localStorage.getItem(POLICY_METRICS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveMetrics(metrics) {
  try {
    localStorage.setItem(POLICY_METRICS_KEY, JSON.stringify(metrics));
  } catch {}
}

// ── Correlation ID generator ───────────────────────────────────────────────────

/**
 * Generate a distributed-trace-style correlation ID.
 * Format: {prefix}_{epochMs}_{random7}
 */
export function generateCorrelationId(prefix = 'eval') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// ── Per-policy metric initialiser ──────────────────────────────────────────────

function ensurePolicyBucket(metrics, policyId, policyName) {
  if (!metrics[policyId]) {
    metrics[policyId] = {
      policyId,
      policyName:      policyName || policyId,
      triggerCount:    0,
      denyCount:       0,
      escalateCount:   0,
      reviewCount:     0,
      allowCount:      0,
      actionCounts:    {},
      latencySamples:  [],
      lastTriggeredAt: null,
    };
  }
  return metrics[policyId];
}

// ── Record a full evaluation run ───────────────────────────────────────────────

/**
 * Call after every evaluatePolicies() run (including dry-runs).
 */
export function recordPolicyEvaluation({
  triggeredPolicies = [],
  finalEffect       = 'ALLOW',
  actions           = [],
  evaluationLatencyMs = 0,
  isDryRun          = false,
} = {}) {
  const metrics = loadMetrics();

  // ── Engine-level bucket ──
  if (!metrics._engine) {
    metrics._engine = {
      totalEvaluations:   0,
      dryRunEvaluations:  0,
      totalDenials:       0,
      totalEscalations:   0,
      totalReviews:       0,
      totalAllows:        0,
      latencySamples:     [],
      actionDistribution: {},
      lastEvaluatedAt:    null,
    };
  }

  const eng = metrics._engine;
  eng.totalEvaluations  += 1;
  if (isDryRun) eng.dryRunEvaluations += 1;

  switch (finalEffect) {
    case 'DENY':     eng.totalDenials     += 1; break;
    case 'ESCALATE': eng.totalEscalations += 1; break;
    case 'REVIEW':   eng.totalReviews     += 1; break;
    default:         eng.totalAllows      += 1;
  }

  eng.latencySamples.push(evaluationLatencyMs);
  if (eng.latencySamples.length > MAX_LATENCY_SAMPLES) eng.latencySamples.shift();
  eng.lastEvaluatedAt = Date.now();

  actions.forEach(a => {
    eng.actionDistribution[a] = (eng.actionDistribution[a] || 0) + 1;
  });

  // ── Per-policy buckets ──
  triggeredPolicies.forEach(p => {
    const bucket = ensurePolicyBucket(metrics, p.id || p.policyId, p.name || p.policyName);

    bucket.triggerCount    += 1;
    bucket.lastTriggeredAt  = Date.now();
    if (p.name || p.policyName) bucket.policyName = p.name || p.policyName;

    switch (p.effect) {
      case 'DENY':     bucket.denyCount     += 1; break;
      case 'ESCALATE': bucket.escalateCount += 1; break;
      case 'REVIEW':   bucket.reviewCount   += 1; break;
      default:         bucket.allowCount    += 1;
    }

    bucket.latencySamples.push(evaluationLatencyMs);
    if (bucket.latencySamples.length > MAX_LATENCY_SAMPLES) bucket.latencySamples.shift();

    (p.actions || []).forEach(a => {
      bucket.actionCounts[a] = (bucket.actionCounts[a] || 0) + 1;
    });
  });

  saveMetrics(metrics);

  // Opportunistically forward to the shared observability platform.
  // We import lazily to avoid boot-order issues — failures are silent.
  try {
    const { track } = globalThis.__zuriObs__ || {};
    if (typeof track === 'function') {
      track('policy_evaluation_count', 1, { finalEffect, isDryRun: String(isDryRun) });
      track('policy_evaluation_latency_ms', evaluationLatencyMs);
    }
  } catch {}
}

// ── Getters ────────────────────────────────────────────────────────────────────

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor(sorted.length * p);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function latencyStats(samples) {
  if (!samples || samples.length === 0) return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const avg    = Math.round(samples.reduce((s, v) => s + v, 0) / samples.length);
  return {
    avg,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Get metrics for a specific policy, or all policies (as a map) when policyId is omitted.
 */
export function getPolicyMetrics(policyId) {
  const metrics = loadMetrics();

  if (policyId) {
    const b = metrics[policyId];
    if (!b) return null;
    return { ...b, latency: latencyStats(b.latencySamples) };
  }

  return Object.entries(metrics)
    .filter(([k]) => k !== '_engine')
    .reduce((acc, [k, b]) => {
      acc[k] = { ...b, latency: latencyStats(b.latencySamples) };
      return acc;
    }, {});
}

/**
 * Engine-wide aggregated metrics.
 */
export function getEngineMetrics() {
  const metrics = loadMetrics();
  const eng     = metrics._engine || {};
  const latency = latencyStats(eng.latencySamples || []);

  const total  = eng.totalEvaluations || 0;
  const rate   = n => total > 0 ? ((n / total) * 100).toFixed(2) + '%' : '0.00%';

  return {
    totalEvaluations:        total,
    dryRunEvaluations:       eng.dryRunEvaluations    || 0,
    totalDenials:            eng.totalDenials         || 0,
    totalEscalations:        eng.totalEscalations     || 0,
    totalReviews:            eng.totalReviews         || 0,
    totalAllows:             eng.totalAllows          || 0,
    denialRate:              rate(eng.totalDenials    || 0),
    escalationRate:          rate(eng.totalEscalations || 0),
    latency,
    actionDistribution:      eng.actionDistribution   || {},
    lastEvaluatedAt:         eng.lastEvaluatedAt,
    lastEvaluatedAtISO:      eng.lastEvaluatedAt
      ? new Date(eng.lastEvaluatedAt).toISOString()
      : null,
  };
}

export function getTopTriggeredPolicies(limit = 10) {
  const metrics = loadMetrics();
  return Object.values(metrics)
    .filter(b => b && b.policyId && (b.triggerCount || 0) > 0)
    .sort((a, b) => (b.triggerCount || 0) - (a.triggerCount || 0))
    .slice(0, limit)
    .map(b => ({
      policyId:        b.policyId,
      policyName:      b.policyName,
      triggerCount:    b.triggerCount,
      denyCount:       b.denyCount    || 0,
      escalateCount:   b.escalateCount || 0,
      avgLatencyMs:    latencyStats(b.latencySamples).avg,
      lastTriggeredAt: b.lastTriggeredAt,
    }));
}

// ── Diagnostics report ─────────────────────────────────────────────────────────

export function generatePolicyDiagnosticsReport() {
  const eng         = getEngineMetrics();
  const topPolicies = getTopTriggeredPolicies(5);

  const observations = [];
  if (parseFloat(eng.denialRate)    > 10) observations.push('Denial rate > 10% — review policy thresholds');
  if (parseFloat(eng.escalationRate) > 40) observations.push('Escalation rate > 40% — may cause user friction');
  if (eng.latency.p95 > 100)             observations.push('p95 evaluation latency > 100ms — investigate slow policies');
  if (eng.totalEvaluations === 0)        observations.push('No evaluations recorded — engine may not be integrated');

  return {
    reportedAt:       new Date().toISOString(),
    engine:           eng,
    topTriggeredPolicies: topPolicies,
    healthStatus:     eng.latency.avg > 100 ? 'DEGRADED' : 'HEALTHY',
    observations,
  };
}

// ── Reset ──────────────────────────────────────────────────────────────────────

export function resetPolicyMetrics(policyId) {
  const metrics = loadMetrics();
  if (policyId) {
    delete metrics[policyId];
  } else {
    Object.keys(metrics).forEach(k => delete metrics[k]);
  }
  saveMetrics(metrics);
}
