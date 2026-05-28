/**
 * Zuri Connect Africa — Settlement API Layer
 */

import * as SettlementLib     from '@/lib/settlementEngine';
import { obs, METRICS }       from '@/lib/observability';
import { emit, EVENTS }       from '@/lib/eventBus';
import { audit }              from '@/lib/auditLogger';

export async function queueSettlement(txRef, amount, fromPhone, toPhone, idempotencyKey) {
  const trace = obs.startTrace('settlement.queue');
  try {
    obs.info('settlement.queue', { txRef, amount });
    const job = SettlementLib.queueSettlement(txRef, amount, fromPhone, toPhone, idempotencyKey);
    obs.endTrace(trace.traceId);
    return job;
  } catch (err) {
    obs.error('settlement.queue failed', { error: err.message, txRef });
    obs.track(METRICS.SETTLEMENT_FAILURE, 1);
    obs.endTrace(trace.traceId);
    throw err;
  }
}

export function getSettlementStatus(txRef) {
  return SettlementLib.getSettlementStatus(txRef);
}

export async function retryFailed(userId) {
  const trace = obs.startTrace('settlement.retryFailed');
  try {
    obs.info('settlement.retryFailed', { userId });
    const result = await SettlementLib.retryFailedSettlements();
    audit.reconciliationRun(userId, null, { type: 'settlement_retry' });
    emit(EVENTS.RECONCILIATION_COMPLETED, { type: 'retry', result });
    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('settlement.retryFailed failed', { error: err.message });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

export function getAllSettlements() {
  return SettlementLib.getAllSettlements();
}