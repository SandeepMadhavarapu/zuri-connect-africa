/**
 * Zuri Connect Africa — Ledger API Layer
 * Abstracts all ledger interactions. Components never call lib/ledger directly.
 */

import * as LedgerLib         from '@/lib/ledger';
import { obs, METRICS }       from '@/lib/observability';
import { emit, EVENTS }       from '@/lib/eventBus';
import { audit }              from '@/lib/auditLogger';
import { isClientDemoLedgerAllowed } from '@/lib/clientLedgerGuard.js';

// ── Post Transaction ──────────────────────────────────────────────────────────

export async function postTransaction(opts) {
  const trace = obs.startTrace('ledger.postTransaction');
  try {
    if (!isClientDemoLedgerAllowed()) {
      throw new Error(
        'CLIENT_LEDGER_FORBIDDEN: src/api/ledger.js postTransaction is local-demo only. Use src/services/paymentService.js initiateServerPayment or initiateAndWaitForPayment for production money movement.'
      );
    }

    obs.info('ledger.postTransaction', { amount: opts.amount, from: opts.fromPhone });
    const result = await LedgerLib.postTransaction(opts);
    obs.track(METRICS.LEDGER_POST_COUNT, 1);
    emit(EVENTS.LEDGER_POSTED, { txRef: result.txRef, amount: opts.amount });
    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('ledger.postTransaction failed', { error: err.message });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

// ── Derive Balance ────────────────────────────────────────────────────────────

export async function deriveBalance(phone) {
  const trace = obs.startTrace('ledger.deriveBalance');
  try {
    const balance = await LedgerLib.deriveBalance(phone);
    obs.endTrace(trace.traceId);
    return balance;
  } catch (err) {
    obs.error('ledger.deriveBalance failed', { error: err.message, phone });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

// ── Get Statement ─────────────────────────────────────────────────────────────

export async function getStatement(phone, limit = 20) {
  const trace = obs.startTrace('ledger.getStatement');
  try {
    const entries = await LedgerLib.getStatement(phone, limit);
    obs.endTrace(trace.traceId);
    return entries;
  } catch (err) {
    obs.error('ledger.getStatement failed', { error: err.message, phone });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

// ── Run Reconciliation ────────────────────────────────────────────────────────

export async function runReconciliation(userId) {
  const trace = obs.startTrace('ledger.runReconciliation');
  try {
    obs.info('ledger.runReconciliation started', { userId });
    const result = await LedgerLib.runReconciliation();
    audit.reconciliationRun(userId, null, { status: result.status, entriesChecked: result.entriesChecked });
    emit(EVENTS.RECONCILIATION_COMPLETED, result);
    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('ledger.runReconciliation failed', { error: err.message });
    obs.endTrace(trace.traceId);
    throw err;
  }
}
