/**
 * Telecom-grade observability platform.
 * Adds request/tx/auth/queue traces, runtime health, and monitor snapshots.
 */

import { getMetrics, track, LOG_LEVELS, log } from '@/lib/observability';
import { getQueueStats, getDeadLetterJobs, QUEUES } from '@/lib/queue';
import { getWebhookQueueStats } from '@/backend/webhooks/webhookQueue';
import { getWebhookDeadLetterDepth } from '@/backend/webhooks/deadLetterQueue';
import { getFraudGraphSnapshot } from '@/backend/fraud/fraudGraph';
import { getThreatIntelSnapshot } from '@/backend/fraud/threatIntel';
import { getReputationSnapshot } from '@/backend/fraud/reputationEngine';
import { getReconciliationSnapshots } from '@/backend/reconciliation/reconciliationEngine';
import { recoverSettlements } from '@/backend/reconciliation/settlementRecovery';
import { getAllSettlements, SETTLEMENT_STATUS } from '@/lib/settlementEngine';
import { getSuspiciousActivityLog, validateSession } from '@/lib/sessionSecurity';
import { isBootLoggingEnabled } from '@/lib/devLog.js';

const TRACE_KEY = 'zuri_distributed_traces_v1';
const HEALTH_KEY = 'zuri_runtime_health_v1';
const MONITOR_KEY = 'zuri_monitor_snapshots_v1';
const MAX_TRACES = 500;
const MAX_MONITORS = 300;

let runtimeMonitorTimer = null;
let startupWatchdogTimer = null;
let runtimeTickCount = 0;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function createCorrelationId(prefix = 'corr') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function startDistributedTrace(name, metadata = {}) {
  const trace = {
    traceId: createCorrelationId('trace'),
    name,
    metadata,
    spans: [],
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    status: 'open',
  };
  const traces = readJson(TRACE_KEY, []);
  traces.push(trace);
  if (traces.length > MAX_TRACES) traces.splice(0, traces.length - MAX_TRACES);
  writeJson(TRACE_KEY, traces);
  return trace;
}

export function addTraceSpan(traceId, name, metadata = {}) {
  const traces = readJson(TRACE_KEY, []);
  const trace = traces.find(item => item.traceId === traceId);
  if (!trace) return null;
  const span = {
    spanId: createCorrelationId('span'),
    name,
    metadata,
    timestamp: Date.now(),
  };
  trace.spans.push(span);
  writeJson(TRACE_KEY, traces);
  return span;
}

export function endDistributedTrace(traceId, status = 'ok', metadata = {}) {
  const traces = readJson(TRACE_KEY, []);
  const trace = traces.find(item => item.traceId === traceId);
  if (!trace) return null;
  trace.endedAt = Date.now();
  trace.durationMs = trace.endedAt - trace.startedAt;
  trace.status = status;
  trace.metadata = { ...trace.metadata, ...metadata };
  writeJson(TRACE_KEY, traces);
  track('distributed_trace_duration_ms', trace.durationMs, { name: trace.name, status });
  return trace;
}

export function getDistributedTraces({ txRef, type, limit = 100 } = {}) {
  return readJson(TRACE_KEY, [])
    .filter(trace => !type || trace.name.includes(type))
    .filter(trace => !txRef || trace.metadata?.txRef === txRef || trace.spans?.some(span => span.metadata?.txRef === txRef))
    .slice(-limit)
    .reverse();
}

export function collectQueueMonitor() {
  const settlement = getQueueStats(QUEUES.SETTLEMENT);
  const webhook = getWebhookQueueStats();
  const dlq = getDeadLetterJobs();
  const webhookDlqDepth = getWebhookDeadLetterDepth();

  return {
    settlement,
    webhook,
    durableDeadLetters: dlq.length,
    webhookDeadLetters: webhookDlqDepth,
    totalPending: settlement.pending + webhook.pending,
    totalFailed: settlement.failed + webhook.failed,
    totalDead: settlement.dead + webhook.dead + dlq.length + webhookDlqDepth,
  };
}

export function collectFraudMonitor() {
  const graph = getFraudGraphSnapshot().analysis;
  const threats = getThreatIntelSnapshot();
  const reputation = getReputationSnapshot();

  return {
    graph,
    highRiskThreatClusters: threats.highRiskClusters,
    riskyRecipients: reputation.highRiskRecipientCount,
    riskyMerchants: reputation.riskyMerchantCount,
    campaignScore: graph.campaignScore,
  };
}

export function collectSettlementMonitor() {
  const settlements = Object.values(getAllSettlements() || {});
  const settled = settlements.filter(item => item.settlementStatus === SETTLEMENT_STATUS.SETTLED).length;
  const failed = settlements.filter(item => item.settlementStatus === SETTLEMENT_STATUS.FAILED).length;
  const pending = settlements.filter(item => item.settlementStatus === SETTLEMENT_STATUS.PENDING).length;
  const processing = settlements.filter(item => item.settlementStatus === SETTLEMENT_STATUS.PROCESSING).length;
  const total = settlements.length;

  return {
    total,
    settled,
    failed,
    pending,
    processing,
    failureRate: total ? Math.round((failed / total) * 100) : 0,
    pendingRate: total ? Math.round((pending / total) * 100) : 0,
  };
}

export function collectAuthMonitor() {
  const session = validateSession();
  const suspicious = getSuspiciousActivityLog();
  const recentCutoff = Date.now() - 15 * 60 * 1000;

  return {
    session,
    suspiciousEvents: suspicious.length,
    recentSuspiciousEvents: suspicious.filter(item => item.timestamp >= recentCutoff).length,
  };
}

export function collectRuntimeHealth() {
  const queue = collectQueueMonitor();
  const fraud = collectFraudMonitor();
  const settlement = collectSettlementMonitor();
  const auth = collectAuthMonitor();
  const reconciliation = getReconciliationSnapshots(1)[0] || null;
  const metrics = getMetrics();

  const degradedSignals = [];
  if (queue.totalDead > 0) degradedSignals.push('dead_letter_backlog');
  if (queue.totalFailed > 3) degradedSignals.push('queue_failures');
  if (settlement.failureRate > 10) degradedSignals.push('settlement_failure_rate_high');
  if (fraud.campaignScore >= 70) degradedSignals.push('fraud_campaign_elevated');
  if (auth.recentSuspiciousEvents > 3) degradedSignals.push('auth_attack_activity');
  if (reconciliation?.status === 'discrepancy') degradedSignals.push('reconciliation_discrepancy');

  const health = {
    status: degradedSignals.length ? 'degraded' : 'healthy',
    degradedSignals,
    queue,
    fraud,
    settlement,
    auth,
    reconciliation,
    metrics,
    timestamp: Date.now(),
  };

  writeJson(HEALTH_KEY, health);
  return health;
}

export function appendMonitorSnapshot(type, payload) {
  const snapshots = readJson(MONITOR_KEY, []);
  snapshots.push({
    id: `monitor_${type}_${Date.now()}`,
    type,
    payload,
    timestamp: Date.now(),
  });
  if (snapshots.length > MAX_MONITORS) snapshots.splice(0, snapshots.length - MAX_MONITORS);
  writeJson(MONITOR_KEY, snapshots);
}

export function startStartupWatchdog(timeoutMs = 12000) {
  clearTimeout(startupWatchdogTimer);
  startupWatchdogTimer = setTimeout(() => {
    const health = collectRuntimeHealth();
    if (isBootLoggingEnabled()) {
      log(LOG_LEVELS.WARN, 'startup watchdog health sample', {
        status: health.status,
        degradedSignals: health.degradedSignals,
      });
    }
    appendMonitorSnapshot('startup_watchdog', health);
  }, timeoutMs);
  return () => clearTimeout(startupWatchdogTimer);
}

export function startRuntimeHealthMonitor({ intervalMs = 30000 } = {}) {
  clearInterval(runtimeMonitorTimer);
  const tick = () => {
    runtimeTickCount += 1;
    const health = collectRuntimeHealth();
    appendMonitorSnapshot('runtime_health', health);
    track('runtime_health_status', health.status === 'healthy' ? 1 : 0, { status: health.status });
    if (runtimeTickCount % 4 === 0 && (
      health.settlement.failed > 0 ||
      health.settlement.pendingRate > 25 ||
      health.degradedSignals.includes('settlement_failure_rate_high')
    )) {
      recoverSettlements().catch(err => {
        log(LOG_LEVELS.WARN, 'settlement recovery monitor failed', { error: err.message });
      });
    }
  };
  tick();
  runtimeMonitorTimer = setInterval(tick, intervalMs);
  return () => clearInterval(runtimeMonitorTimer);
}

export function stopRuntimeHealthMonitor() {
  clearInterval(runtimeMonitorTimer);
  clearTimeout(startupWatchdogTimer);
}

export function getRuntimeHealth() {
  return readJson(HEALTH_KEY, null) || collectRuntimeHealth();
}

export function getMonitorSnapshots({ type, limit = 50 } = {}) {
  return readJson(MONITOR_KEY, [])
    .filter(snapshot => !type || snapshot.type === type)
    .slice(-limit)
    .reverse();
}

export const telecomObservability = {
  createCorrelationId,
  startDistributedTrace,
  addTraceSpan,
  endDistributedTrace,
  getDistributedTraces,
  collectRuntimeHealth,
  collectQueueMonitor,
  collectFraudMonitor,
  collectSettlementMonitor,
  collectAuthMonitor,
  startStartupWatchdog,
  startRuntimeHealthMonitor,
  stopRuntimeHealthMonitor,
  getRuntimeHealth,
  getMonitorSnapshots,
};
