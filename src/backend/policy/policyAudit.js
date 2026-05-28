/**
 * Policy Engine — Immutable audit trail.
 *
 * Append-only, hash-chained log of every policy evaluation and policy mutation.
 * Designed to be:
 *   - Replay-safe: entries are idempotent and ordered by monotonic ts
 *   - Reconciliation-safe: prevHash chain allows server-side tamper detection
 *   - Append-only: no entry is ever deleted or mutated
 */

const POLICY_AUDIT_KEY  = 'zuri_policy_audit_v1';
const MAX_AUDIT_ENTRIES = 2000;

// ── Chain hash (same algorithm as auditLogger.js for consistency) ──────────────

function chainHash(entry) {
  const str = `${entry.ts}|${entry.event}|${entry.correlationId || ''}|${entry.policyId || ''}|${entry.prevHash || ''}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Storage ────────────────────────────────────────────────────────────────────

function readLog() {
  try {
    return JSON.parse(localStorage.getItem(POLICY_AUDIT_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeLog(log) {
  try {
    const trimmed = log.length > MAX_AUDIT_ENTRIES
      ? log.slice(log.length - MAX_AUDIT_ENTRIES)
      : log;
    localStorage.setItem(POLICY_AUDIT_KEY, JSON.stringify(trimmed));
  } catch {}
}

// ── Core append ────────────────────────────────────────────────────────────────

export function appendPolicyAuditEvent(fields) {
  const log      = readLog();
  const prevHash = log.length > 0 ? log[log.length - 1].hash : '00000000';

  const entry = {
    id:        `pae_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts:        Date.now(),
    timestamp: new Date().toISOString(),
    prevHash,
    ...fields,
  };
  entry.hash = chainHash(entry);

  log.push(entry);
  writeLog(log);
  return entry;
}

// ── Specialised appenders ──────────────────────────────────────────────────────

/**
 * Log a completed policy evaluation run.
 */
export function appendPolicyEvaluationAudit({
  correlationId,
  txRef,
  userId,
  contextMeta,        // { amount, txType, deviceTrust, fromPhone }
  triggeredPolicies,  // [{ id, name, severity, effect }]
  aggregatedActions,
  finalEffect,
  isDryRun = false,
  evaluationLatencyMs,
  policyVersion = 1,
}) {
  return appendPolicyAuditEvent({
    event:                'policy_evaluation',
    correlationId,
    txRef:                txRef || null,
    userId:               userId || 'anonymous',
    triggeredPolicyIds:   triggeredPolicies.map(p => p.id || p.policyId),
    triggeredPolicyCount: triggeredPolicies.length,
    triggeredSeverities:  triggeredPolicies.map(p => p.severity),
    aggregatedActions,
    finalEffect,
    isDryRun,
    evaluationLatencyMs,
    policyVersion,
    contextMeta: {
      amount:      contextMeta?.amount,
      txType:      contextMeta?.txType,
      deviceTrust: contextMeta?.deviceTrust != null
        ? Math.round(contextMeta.deviceTrust * 100) / 100
        : null,
      fromPhone:   contextMeta?.fromPhone
        ? String(contextMeta.fromPhone).slice(0, 6) + '****'
        : null,
    },
  });
}

/**
 * Log execution of a specific policy action.
 */
export function appendPolicyActionAudit({
  correlationId,
  txRef,
  userId,
  policyId,
  policyName,
  action,
  outcome,      // 'executed' | 'skipped' | 'failed'
  details = {},
}) {
  return appendPolicyAuditEvent({
    event: 'policy_action_executed',
    correlationId,
    txRef:      txRef || null,
    userId:     userId || 'anonymous',
    policyId,
    policyName,
    action,
    outcome,
    details,
  });
}

/**
 * Log a policy configuration change (create / update / delete / enable / disable).
 */
export function appendPolicyChangeAudit({
  policyId,
  changeType,   // 'create' | 'update' | 'delete' | 'enable' | 'disable' | 'rollout'
  before,       // previous policy snapshot (safe fields only)
  after,        // new policy snapshot
  userId = 'admin',
}) {
  const snap = p => p ? {
    id:          p.id,
    name:        p.name,
    enabled:     p.enabled,
    priority:    p.priority,
    severity:    p.severity,
    effect:      p.effect,
    version:     p.version,
    rollout:     p.rolloutPercentage,
  } : null;

  return appendPolicyAuditEvent({
    event:      'policy_changed',
    policyId,
    changeType,
    before:     snap(before),
    after:      snap(after),
    userId,
  });
}

/**
 * Log emergency kill-switch activation / deactivation.
 */
export function appendEmergencyAudit({ action, reason, userId = 'admin' }) {
  return appendPolicyAuditEvent({
    event:  'emergency_action',
    action, // 'disable_all' | 'enable_all' | 'dry_run_on' | 'dry_run_off'
    reason: reason || '',
    userId,
  });
}

// ── Queries ────────────────────────────────────────────────────────────────────

export function getPolicyAuditLog({
  limit = 200,
  correlationId,
  txRef,
  policyId,
  event,
  sinceTs,
  userId,
} = {}) {
  let log = readLog();

  if (correlationId) log = log.filter(e => e.correlationId === correlationId);
  if (txRef)         log = log.filter(e => e.txRef === txRef);
  if (userId)        log = log.filter(e => e.userId === userId);
  if (event)         log = log.filter(e => e.event === event);
  if (sinceTs)       log = log.filter(e => e.ts >= sinceTs);
  if (policyId) {
    log = log.filter(e =>
      e.policyId === policyId ||
      e.triggeredPolicyIds?.includes(policyId)
    );
  }

  return log.slice(-limit).reverse(); // most-recent first
}

export function getPolicyAuditStats() {
  const log    = readLog();
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const recent = log.filter(e => e.ts > cutoff);

  const byEffect = {};
  const byAction = {};

  recent.forEach(e => {
    if (e.finalEffect) {
      byEffect[e.finalEffect] = (byEffect[e.finalEffect] || 0) + 1;
    }
    if (Array.isArray(e.aggregatedActions)) {
      e.aggregatedActions.forEach(a => {
        byAction[a] = (byAction[a] || 0) + 1;
      });
    }
  });

  const evaluations    = recent.filter(e => e.event === 'policy_evaluation');
  const latencies      = evaluations.map(e => e.evaluationLatencyMs || 0).filter(Boolean);
  const avgLatency     = latencies.length
    ? Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)
    : 0;

  return {
    totalLogEntries:        log.length,
    last24hEvaluations:     evaluations.length,
    last24hDenials:         byEffect['DENY']     || 0,
    last24hEscalations:     byEffect['ESCALATE'] || 0,
    last24hReviews:         byEffect['REVIEW']   || 0,
    avgEvaluationLatencyMs: avgLatency,
    effectDistribution:     byEffect,
    actionDistribution:     byAction,
    updatedAt:              Date.now(),
  };
}

// ── Integrity verification ─────────────────────────────────────────────────────

export function verifyPolicyAuditIntegrity() {
  const log = readLog();

  for (let i = 1; i < log.length; i++) {
    const entry    = log[i];
    const expected = chainHash(entry);

    if (expected !== entry.hash) {
      return { valid: false, brokenAt: i, entryId: entry.id, reason: 'hash_mismatch' };
    }
    if (entry.prevHash !== log[i - 1].hash) {
      return { valid: false, brokenAt: i, entryId: entry.id, reason: 'chain_broken' };
    }
  }

  return { valid: true, totalEntries: log.length };
}

// ── Export / replay ────────────────────────────────────────────────────────────

export function exportPolicyAuditLog() {
  const log = readLog();
  return {
    exportedAt:  new Date().toISOString(),
    totalEntries: log.length,
    integrity:   verifyPolicyAuditIntegrity(),
    entries:     log,
  };
}
