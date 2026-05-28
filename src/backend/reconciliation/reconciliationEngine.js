/**
 * Telecom-grade reconciliation engine.
 * Runs replay-safe ledger checks and settlement consistency reports.
 */

import * as ledgerService from '@/services/ledgerService.js';
import * as reconciliationService from '@/services/reconciliationService.js';
import { computeHash, round } from '@/lib/ledger';
import { getAllSettlements, SETTLEMENT_STATUS } from '@/lib/settlementEngine';
import { emit } from '@/lib/eventBus';
import { obs } from '@/lib/observability';

const SNAPSHOT_KEY = 'zuri_reconciliation_snapshots_v1';
const REPORT_KEY = 'zuri_reconciliation_reports_v1';
const JOB_LOCK_KEY = 'zuri_reconciliation_job_locks_v1';
const SNAPSHOT_LIMIT = 90;
const REPORT_LIMIT = 120;

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

function txGroups(entries) {
  return entries.reduce((groups, entry) => {
    const ref = entry.transactionRef || 'missing';
    groups[ref] = groups[ref] || [];
    groups[ref].push(entry);
    return groups;
  }, {});
}

function settlementList() {
  return Object.values(getAllSettlements() || {});
}

function appendSnapshot(snapshot) {
  const snapshots = readJson(SNAPSHOT_KEY, []);
  snapshots.push(snapshot);
  if (snapshots.length > SNAPSHOT_LIMIT) snapshots.splice(0, snapshots.length - SNAPSHOT_LIMIT);
  writeJson(SNAPSHOT_KEY, snapshots);
  return snapshot;
}

function appendReport(report) {
  const reports = readJson(REPORT_KEY, []);
  reports.push(report);
  if (reports.length > REPORT_LIMIT) reports.splice(0, reports.length - REPORT_LIMIT);
  writeJson(REPORT_KEY, reports);
  return report;
}

function acquireJobLock(jobKey) {
  const locks = readJson(JOB_LOCK_KEY, {});
  const existing = locks[jobKey];
  const now = Date.now();
  if (existing && existing.expiresAt > now) {
    return { acquired: false, lock: existing };
  }
  const lock = {
    jobKey,
    acquiredAt: now,
    expiresAt: now + 10 * 60 * 1000,
  };
  locks[jobKey] = lock;
  writeJson(JOB_LOCK_KEY, locks);
  return { acquired: true, lock };
}

function releaseJobLock(jobKey) {
  const locks = readJson(JOB_LOCK_KEY, {});
  delete locks[jobKey];
  writeJson(JOB_LOCK_KEY, locks);
}

export async function replayLedger(entries) {
  const replay = {
    entriesChecked: 0,
    totalDebits: 0,
    totalCredits: 0,
    hashFailures: [],
    balanceFailures: [],
    transactionGroups: txGroups(entries),
  };

  for (const entry of entries) {
    replay.entriesChecked += 1;
    if (entry.entryType === 'debit') replay.totalDebits = round(replay.totalDebits + Number(entry.amount || 0));
    if (entry.entryType === 'credit') replay.totalCredits = round(replay.totalCredits + Number(entry.amount || 0));

    if (entry.hash) {
      const expected = await computeHash(entry);
      if (expected !== entry.hash) {
        replay.hashFailures.push({
          txRef: entry.transactionRef,
          accountPhone: entry.accountPhone,
          expected,
          actual: entry.hash,
        });
      }
    }

    const expectedAfter = entry.entryType === 'debit'
      ? round(Number(entry.balanceBefore || 0) - Number(entry.amount || 0))
      : round(Number(entry.balanceBefore || 0) + Number(entry.amount || 0));
    if (round(Number(entry.balanceAfter || 0)) !== expectedAfter) {
      replay.balanceFailures.push({
        txRef: entry.transactionRef,
        accountPhone: entry.accountPhone,
        expectedAfter,
        actualAfter: entry.balanceAfter,
      });
    }
  }

  replay.difference = round(Math.abs(replay.totalDebits - replay.totalCredits));
  replay.balanced = replay.difference === 0;
  return replay;
}

export function detectOrphanTransactions(entries, settlements = settlementList()) {
  const ledgerRefs = new Set(entries.map(entry => entry.transactionRef));
  const settlementRefs = new Set(settlements.map(settlement => settlement.txRef));

  return {
    settlementsWithoutLedger: settlements
      .filter(settlement => settlement.txRef && !ledgerRefs.has(settlement.txRef))
      .map(settlement => ({
        txRef: settlement.txRef,
        amount: settlement.amount,
        status: settlement.settlementStatus,
        updatedAt: settlement.updatedAt,
      })),
    ledgerWithoutSettlement: Array.from(ledgerRefs)
      .filter(txRef => txRef && !settlementRefs.has(txRef) && !String(txRef).startsWith('REV-'))
      .slice(0, 100),
  };
}

export function detectSettlementMismatches(entries, settlements = settlementList()) {
  const groups = txGroups(entries);
  return settlements.map(settlement => {
    const legs = groups[settlement.txRef] || [];
    const debit = legs.find(entry => entry.entryType === 'debit');
    const credit = legs.find(entry => entry.entryType === 'credit');
    const ledgerAmount = debit?.amount ?? credit?.amount ?? 0;
    const amountMismatch = settlement.amount && ledgerAmount && round(Number(settlement.amount)) !== round(Number(ledgerAmount));

    return {
      txRef: settlement.txRef,
      settlementStatus: settlement.settlementStatus,
      settlementAmount: settlement.amount,
      ledgerAmount,
      hasDebit: Boolean(debit),
      hasCredit: Boolean(credit),
      amountMismatch,
      failedSettlement: settlement.settlementStatus === SETTLEMENT_STATUS.FAILED,
      pendingTooLong: settlement.settlementStatus === SETTLEMENT_STATUS.PENDING &&
        Date.now() - (settlement.updatedAt || settlement.createdAt || Date.now()) > 30 * 60 * 1000,
    };
  }).filter(item =>
    item.amountMismatch ||
    !item.hasDebit ||
    !item.hasCredit ||
    item.failedSettlement ||
    item.pendingTooLong
  );
}

export function detectDuplicateSettlements(settlements = settlementList()) {
  const seen = {};
  settlements.forEach(settlement => {
    if (!settlement.txRef) return;
    seen[settlement.txRef] = seen[settlement.txRef] || [];
    seen[settlement.txRef].push(settlement);
  });

  return Object.entries(seen)
    .filter(([, records]) => records.length > 1)
    .map(([txRef, records]) => ({
      txRef,
      count: records.length,
      statuses: records.map(record => record.settlementStatus),
      records,
    }));
}

export function createCorrectionPlan(report) {
  const corrections = [];

  report.settlementMismatches.forEach(mismatch => {
    if (mismatch.failedSettlement || mismatch.pendingTooLong) {
      corrections.push({
        type: 'settlement_recovery',
        txRef: mismatch.txRef,
        action: 'retry_or_mark_failed_without_ledger_mutation',
      });
    }
    if (mismatch.amountMismatch) {
      corrections.push({
        type: 'ledger_adjustment_required',
        txRef: mismatch.txRef,
        action: 'append_correction_transaction_after_manual_review',
        difference: round(Math.abs(Number(mismatch.settlementAmount || 0) - Number(mismatch.ledgerAmount || 0))),
      });
    }
  });

  report.duplicates.forEach(duplicate => {
    corrections.push({
      type: 'duplicate_settlement',
      txRef: duplicate.txRef,
      action: 'suppress_replay_and_preserve_original_settlement',
      duplicateCount: duplicate.count,
    });
  });

  return corrections;
}

export async function runDailyReconciliation({ runDate = new Date().toISOString().slice(0, 10), force = false } = {}) {
  const jobKey = `daily:${runDate}`;
  const lock = acquireJobLock(jobKey);
  if (!lock.acquired && !force) {
    return { skipped: true, reason: 'reconciliation_already_running', lock: lock.lock };
  }

  const startedAt = performance.now();
  try {
    const entries = await ledgerService.listLedger('created_date', 1000);
    const settlements = settlementList();
    const replay = await replayLedger(entries || []);
    const orphans = detectOrphanTransactions(entries || [], settlements);
    const settlementMismatches = detectSettlementMismatches(entries || [], settlements);
    const duplicates = detectDuplicateSettlements(settlements);

    const status = replay.balanced &&
      replay.hashFailures.length === 0 &&
      replay.balanceFailures.length === 0 &&
      settlementMismatches.length === 0 &&
      duplicates.length === 0
      ? 'balanced'
      : 'discrepancy';

    const baseLog = await reconciliationService.createReconciliationLog({
      runDate,
      totalDebits: replay.totalDebits,
      totalCredits: replay.totalCredits,
      difference: replay.difference,
      status,
      entriesChecked: replay.entriesChecked,
    });

    const report = {
      id: `recon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      runDate,
      status,
      replay,
      orphans,
      settlementMismatches,
      duplicates,
      corrections: [],
      baseLogId: baseLog?.id || null,
      durationMs: Math.round(performance.now() - startedAt),
      createdAt: Date.now(),
    };
    report.corrections = createCorrectionPlan(report);
    appendReport(report);

    appendSnapshot({
      id: `snapshot_${runDate}_${Date.now()}`,
      runDate,
      status,
      totalDebits: replay.totalDebits,
      totalCredits: replay.totalCredits,
      difference: replay.difference,
      entriesChecked: replay.entriesChecked,
      settlementCount: settlements.length,
      mismatchCount: settlementMismatches.length,
      duplicateSettlementCount: duplicates.length,
      orphanCount: orphans.settlementsWithoutLedger.length + orphans.ledgerWithoutSettlement.length,
      createdAt: Date.now(),
    });

    obs.track('reconciliation_duration_ms', report.durationMs, { status });
    emit('RECONCILIATION_COMPLETED', report);
    emit('reconciliation.completed', report);
    return report;
  } catch (err) {
    obs.error('daily reconciliation failed', { error: err.message, runDate });
    emit('reconciliation.failed', { runDate, error: err.message });
    throw err;
  } finally {
    releaseJobLock(jobKey);
  }
}

export function getReconciliationSnapshots(limit = 30) {
  return readJson(SNAPSHOT_KEY, []).slice(-limit).reverse();
}

export function getReconciliationReports(limit = 30) {
  return readJson(REPORT_KEY, []).slice(-limit).reverse();
}

export function getSettlementAuditView() {
  const settlements = settlementList();
  return settlements
    .map(record => ({
      txRef: record.txRef,
      amount: record.amount,
      fromPhone: record.fromPhone,
      toPhone: record.toPhone,
      status: record.settlementStatus,
      retryCount: record.retryCount || 0,
      failureReason: record.failureReason || null,
      idempotencyKey: record.idempotencyKey || null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      settledAt: record.settledAt,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getLedgerReplayTooling() {
  const reports = getReconciliationReports(10);
  const latest = reports[0] || null;
  return {
    latest,
    reports,
    snapshots: getReconciliationSnapshots(10),
    canReplaySafely: true,
    ledgerMutationPolicy: 'append_only_corrections_after_review',
  };
}
