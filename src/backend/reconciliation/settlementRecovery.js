/**
 * Automated settlement recovery and eventual consistency helpers.
 */

import {
  getAllSettlements,
  retryFailedSettlements,
  SETTLEMENT_STATUS,
  queueSettlement,
} from '@/lib/settlementEngine';
import { getWebhookQueue } from '@/backend/webhooks/webhookQueue';
import { emit } from '@/lib/eventBus';
import { obs } from '@/lib/observability';

const RECOVERY_KEY = 'zuri_settlement_recovery_runs_v1';

function readRuns() {
  try {
    return JSON.parse(localStorage.getItem(RECOVERY_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeRuns(runs) {
  try {
    localStorage.setItem(RECOVERY_KEY, JSON.stringify(runs.slice(-100)));
  } catch {}
}

export async function recoverSettlements({ stalePendingMs = 30 * 60 * 1000 } = {}) {
  const settlements = Object.values(getAllSettlements() || {});
  const now = Date.now();
  const failed = settlements.filter(item => item.settlementStatus === SETTLEMENT_STATUS.FAILED);
  const stuckPending = settlements.filter(item =>
    item.settlementStatus === SETTLEMENT_STATUS.PENDING &&
    now - (item.updatedAt || item.createdAt || now) > stalePendingMs
  );

  stuckPending.forEach(item => {
    queueSettlement(item.txRef, item.amount, item.fromPhone, item.toPhone, item.idempotencyKey);
  });

  let retryResult = null;
  if (failed.length > 0) {
    retryResult = await retryFailedSettlements();
  }

  const webhookBacklog = getWebhookQueue().filter(job =>
    job.status === 'failed' || job.status === 'pending'
  ).length;

  const run = {
    id: `settlement_recovery_${Date.now()}`,
    failedRetried: failed.length,
    stalePendingRequeued: stuckPending.length,
    webhookBacklog,
    retryResultCount: Array.isArray(retryResult) ? retryResult.length : 0,
    createdAt: Date.now(),
  };

  const runs = readRuns();
  runs.push(run);
  writeRuns(runs);

  emit('settlement.recovery.completed', run);
  obs.track('settlement_recovery_runs', 1, {
    failedRetried: failed.length,
    stalePendingRequeued: stuckPending.length,
  });
  return run;
}

export function getSettlementRecoveryRuns(limit = 20) {
  return readRuns().slice(-limit).reverse();
}
