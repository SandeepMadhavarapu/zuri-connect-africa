/**
 * Zuri Connect Africa — Double-Entry Ledger Engine
 * Immutable, append-only, idempotent-safe double-entry accounting
 * Local-first durability with additive Supabase upsert (non-blocking).
 */

import * as ledgerService from '@/services/ledgerService.js';
import * as reconciliationService from '@/services/reconciliationService.js';
import { generateIdempotencyKey, checkIdempotency, recordIdempotency } from './idempotency';
import { devWarn } from '@/lib/devLog';
import { queueSettlement, runSettlementQueue } from './settlementEngine';
import {
  appendLocalLedgerEntry,
  findLocalEntriesByTransactionRef,
  getLocalEntriesForAccountPhone,
  readAllLocalLedgerEntries,
} from '@/lib/localLedgerStore.js';
import { mergeLedgerArrays } from '@/lib/ledgerMerge.js';
import { postDoubleEntryAtomic } from '@/lib/ledgerRpc.js';
import { track, METRICS } from '@/lib/observability/metrics.js';
import { assertClientLedgerPostingAllowed } from '@/lib/clientLedgerGuard.js';

export const ENTRY_TYPE = {
  DEBIT: 'debit',
  CREDIT: 'credit',
};

export const TX_STATUS = {
  PENDING: 'pending',
  POSTED: 'posted',
  SETTLED: 'settled',
  REVERSED: 'reversed',
  FAILED: 'failed',
};

export function generateTxRef(phone = '') {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = String(phone).slice(-4).padStart(4, '0');
  const randBytes = new Uint8Array(3);
  crypto.getRandomValues(randBytes);
  const rand = Array.from(randBytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `TXN-${date}-${suffix}-${rand}`;
}

export function generateReversalRef(originalRef) {
  return `REV-${originalRef}`;
}

export function round(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export async function computeHash(fields) {
  const raw = [
    fields.transactionRef,
    fields.entryType,
    String(fields.amount),
    String(fields.balanceBefore),
    String(fields.balanceAfter),
    fields.accountPhone,
  ].join('|');

  const encoded = new TextEncoder().encode(raw);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function validateEntry({
  transactionRef,
  entryType,
  amount,
  balanceBefore,
  balanceAfter,
  accountPhone,
}) {
  if (!transactionRef || typeof transactionRef !== 'string') {
    throw new Error('LEDGER_INVALID: transactionRef is required and must be a string');
  }
  if (!Object.values(ENTRY_TYPE).includes(entryType)) {
    throw new Error(`LEDGER_INVALID: entryType must be one of ${Object.values(ENTRY_TYPE).join(', ')}`);
  }
  if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) {
    throw new Error('LEDGER_INVALID: amount must be a positive finite number');
  }
  if (typeof balanceBefore !== 'number' || balanceBefore < 0 || !isFinite(balanceBefore)) {
    throw new Error('LEDGER_INVALID: balanceBefore must be a non-negative finite number');
  }
  if (typeof balanceAfter !== 'number' || balanceAfter < 0 || !isFinite(balanceAfter)) {
    throw new Error('LEDGER_INVALID: balanceAfter must be a non-negative finite number');
  }
  if (!accountPhone) {
    throw new Error('LEDGER_INVALID: accountPhone is required');
  }

  const expectedAfter =
    entryType === ENTRY_TYPE.DEBIT
      ? round(balanceBefore - amount)
      : round(balanceBefore + amount);

  if (round(balanceAfter) !== expectedAfter) {
    throw new Error(
      `LEDGER_INTEGRITY: balanceAfter mismatch. Expected ${expectedAfter}, got ${balanceAfter} ` +
        `(${entryType} of ${amount} from ${balanceBefore})`
    );
  }
}

export function validatePair(debitEntry, creditEntry) {
  if (debitEntry.entryType !== ENTRY_TYPE.DEBIT) {
    throw new Error('LEDGER_PAIR: first entry must be a debit');
  }
  if (creditEntry.entryType !== ENTRY_TYPE.CREDIT) {
    throw new Error('LEDGER_PAIR: second entry must be a credit');
  }
  if (round(debitEntry.amount) !== round(creditEntry.amount)) {
    throw new Error(
      `LEDGER_PAIR: debit (${debitEntry.amount}) and credit (${creditEntry.amount}) amounts must match`
    );
  }
  if (debitEntry.transactionRef !== creditEntry.transactionRef) {
    throw new Error('LEDGER_PAIR: debit and credit must share the same transactionRef');
  }
}

function hasDebitCreditPair(entries) {
  const e = entries || [];
  return (
    e.some((x) => x.entryType === ENTRY_TYPE.DEBIT) &&
    e.some((x) => x.entryType === ENTRY_TYPE.CREDIT)
  );
}

async function ledgerRowsExistForRef(transactionRef) {
  const local = findLocalEntriesByTransactionRef(transactionRef);
  if (local.length > 0) return true;
  let remote = [];
  try {
    remote = await ledgerService.fetchEntriesByTransactionRef(transactionRef);
  } catch {
    remote = [];
  }
  return remote.length > 0;
}

export async function findExistingTransaction(transactionRef) {
  const local = findLocalEntriesByTransactionRef(transactionRef);
  if (hasDebitCreditPair(local)) return local;
  let remote = [];
  try {
    remote = await ledgerService.fetchEntriesByTransactionRef(transactionRef);
  } catch {
    remote = [];
  }
  const merged = mergeLedgerArrays(local, remote, null);
  return hasDebitCreditPair(merged) ? merged : null;
}

function scheduleRemotePersist(entry) {
  Promise.resolve()
    .then(() =>
      ledgerService.persistEntry({
        transactionRef: entry.transactionRef,
        entryType: entry.entryType,
        amount: entry.amount,
        balanceBefore: entry.balanceBefore,
        balanceAfter: entry.balanceAfter,
        accountPhone: entry.accountPhone,
        description: entry.description,
        hash: entry.hash,
        owner: entry.owner,
      })
    )
    .catch(() => {});
}


async function loadMergedAccountEntries(accountPhone) {
  const phone = String(accountPhone || '');
  const local = getLocalEntriesForAccountPhone(phone);
  let remote = [];
  try {
    remote = await ledgerService.fetchEntries(phone, { limit: 5000 });
  } catch {
    remote = [];
  }
  let staleRemote = false;
  const merged = mergeLedgerArrays(local, remote, {
    onStaleRemote: () => {
      staleRemote = true;
    },
  });
  if (staleRemote) {
    try {
      track(METRICS.LEDGER_STALE_READ_DETECTED, 1, {});
    } catch {
      /* non-fatal */
    }
  }
  return merged;
}

/**
 * Synchronous balance from durable local ledger only (instant paint; remote reconcile follows in deriveBalance).
 */
export function deriveBalanceFromLocalLedgerOnly(accountPhone) {
  const phone = String(accountPhone || '');
  const local = getLocalEntriesForAccountPhone(phone);
  return ledgerService.deriveBalanceFromEntries(local, phone).balance;
}

export async function deriveBalance(accountPhone) {
  const phone = String(accountPhone || '');
  const merged = await loadMergedAccountEntries(phone);
  return ledgerService.deriveBalanceFromEntries(merged, phone).balance;
}

export async function deriveBalanceHistory(accountPhone, limit = 50) {
  const phone = String(accountPhone || '');
  const merged = await loadMergedAccountEntries(phone);
  const sorted = [...merged].sort(
    (a, b) =>
      (Date.parse(String(a.created_date || '')) || 0) -
      (Date.parse(String(b.created_date || '')) || 0)
  );
  const slice = sorted.slice(-limit);
  return slice.map((e) => ({
    date: e.created_date,
    transactionRef: e.transactionRef,
    entryType: e.entryType,
    amount: e.amount,
    balance: e.balanceAfter,
    description: e.description,
  }));
}

export async function postTransaction({
  fromPhone,
  toPhone,
  amount,
  description = '',
  txRef,
  owner,
  idempotencyKey,
}) {
  assertClientLedgerPostingAllowed();

  const transactionRef = txRef || generateTxRef(fromPhone);

  const iKey = idempotencyKey || generateIdempotencyKey(fromPhone, 'transfer', amount);
  const cachedResult = checkIdempotency(iKey);
  if (cachedResult) {
    if (import.meta.env.DEV) console.info(`[Ledger] Idempotency replay — key ${iKey}`);
    try {
      track(METRICS.LEDGER_REPLAY_REJECTED, 1, { layer: 'client_idempotency' });
    } catch {
      /* non-fatal */
    }
    return { ...cachedResult, replayed: true };
  }

  const existing = await findExistingTransaction(transactionRef);
  if (existing) {
    devWarn(`[Ledger] Idempotent skip — txRef ${transactionRef} already posted`);
    try {
      track(METRICS.LEDGER_DUPLICATE_PREVENTED, 1, { layer: 'transaction_ref' });
    } catch {
      /* non-fatal */
    }
    const debit = existing.find((e) => e.entryType === ENTRY_TYPE.DEBIT);
    const credit = existing.find((e) => e.entryType === ENTRY_TYPE.CREDIT);
    return { txRef: transactionRef, debit, credit, idempotent: true, status: TX_STATUS.POSTED };
  }

  const senderBalance = await deriveBalance(fromPhone);
  const recipientBalance = await deriveBalance(toPhone);

  if (round(senderBalance) < round(amount)) {
    throw new Error(
      `LEDGER_FUNDS: Insufficient balance. Available: KSh ${senderBalance}, Required: KSh ${amount}`
    );
  }

  const debitPayload = {
    transactionRef,
    entryType: ENTRY_TYPE.DEBIT,
    amount: round(amount),
    accountPhone: fromPhone,
    description: description || `Transfer to ${toPhone}`,
    currentBalance: senderBalance,
    owner,
    idempotencyKey: iKey,
  };

  const creditPayload = {
    transactionRef,
    entryType: ENTRY_TYPE.CREDIT,
    amount: round(amount),
    accountPhone: toPhone,
    description: description || `Transfer from ${fromPhone}`,
    currentBalance: recipientBalance,
    owner,
    idempotencyKey: iKey,
  };

  const mockDebit = { ...debitPayload, entryType: ENTRY_TYPE.DEBIT };
  const mockCredit = { ...creditPayload, entryType: ENTRY_TYPE.CREDIT };
  validatePair(mockDebit, mockCredit);

  // =====================================================
  // Build atomic debit/credit payloads
  // =====================================================

  const debitBalanceBefore = round(senderBalance);
  const debitBalanceAfter = round(debitBalanceBefore - round(amount));
  const creditBalanceBefore = round(recipientBalance);
  const creditBalanceAfter = round(creditBalanceBefore + round(amount));

  const debitForRpc = {
    transactionRef: transactionRef,
    amount: round(amount),
    balanceBefore: debitBalanceBefore,
    balanceAfter: debitBalanceAfter,
    accountPhone: fromPhone,
    description: description || `Transfer to ${toPhone}`,
    owner: owner ?? null,
    idempotencyKey: iKey,
    hash: '',
  };

  const creditForRpc = {
    transactionRef: transactionRef,
    amount: round(amount),
    balanceBefore: creditBalanceBefore,
    balanceAfter: creditBalanceAfter,
    accountPhone: toPhone,
    description: description || `Transfer from ${fromPhone}`,
    owner: owner ?? null,
    idempotencyKey: iKey,
    hash: '',
  };

  // =====================================================
  // Compute hashes before atomic RPC
  // =====================================================

  debitForRpc.hash = await computeHash({ ...debitForRpc, entryType: ENTRY_TYPE.DEBIT });
  creditForRpc.hash = await computeHash({ ...creditForRpc, entryType: ENTRY_TYPE.CREDIT });

  // =====================================================
  // Atomic database write with optimistic concurrency check.
  // Passes debitBalanceBefore so the database can verify
  // no other transaction modified this account between
  // our balance read and this write.
  // Retries ONCE automatically on LEDGER_RACE.
  // =====================================================

  let rpcResult;
  try {
    rpcResult = await postDoubleEntryAtomic(
      debitForRpc,
      creditForRpc,
      debitBalanceBefore
    );
  } catch (err) {
    if (err.message?.includes('LEDGER_RACE')) {
      devWarn('[Ledger] LEDGER_RACE — re-reading balance and retrying once');

      const freshBalance = await deriveBalance(fromPhone);

      if (round(freshBalance) < round(amount)) {
        throw new Error(
          `LEDGER_FUNDS: Insufficient balance after retry. Available: KSh ${freshBalance}`
        );
      }

      const retryDebitBefore = round(freshBalance);
      const retryDebitAfter  = round(retryDebitBefore - round(amount));

      debitForRpc.balanceBefore = retryDebitBefore;
      debitForRpc.balanceAfter  = retryDebitAfter;
      debitForRpc.hash = await computeHash({
        ...debitForRpc,
        entryType: ENTRY_TYPE.DEBIT,
      });

      rpcResult = await postDoubleEntryAtomic(
        debitForRpc,
        creditForRpc,
        retryDebitBefore
      );
    } else {
      throw err;
    }
  }

  // =====================================================
  // Mirror to local ledger for offline-first UX
  // Runs ONLY after successful RPC — never before
  // =====================================================

  let debit;
  let credit;

  try {
    debit = appendLocalLedgerEntry({
      ...debitForRpc,
      entryType: ENTRY_TYPE.DEBIT,
      hash: debitForRpc.hash,
      _source: 'local',
    });

    credit = appendLocalLedgerEntry({
      ...creditForRpc,
      entryType: ENTRY_TYPE.CREDIT,
      hash: creditForRpc.hash,
      _source: 'local',
    });
  } catch (err) {
    devWarn('[Ledger] local mirror append failed (non-fatal):', err);
  }

  if (import.meta.env.DEV) {
    console.info('[PaymentEvent] PAYMENT_CREATED', {
      eventType: 'PAYMENT_CREATED',
      timestamp: new Date().toISOString(),
      environment: 'demo',
      txRef: transactionRef,
      amount,
      fromPhone,
      toPhone,
      description,
      status: TX_STATUS.PENDING,
    });
  }

  queueSettlement(transactionRef, amount, fromPhone, toPhone, iKey);

  const result = { txRef: transactionRef, debit, credit, idempotent: false, status: TX_STATUS.PENDING };

  recordIdempotency(iKey, result);

  setTimeout(() => runSettlementQueue(), 0);

  return result;
}

export async function reverseTransaction(originalRef, reason = 'Reversal', owner) {
  // Guard at function entry — belt-and-braces with the guard inside
  // postDoubleEntryAtomic. Any new code inserted between this line
  // and the RPC call is automatically protected.
  assertClientLedgerPostingAllowed();
  const reversalRef = generateReversalRef(originalRef);

  if (await ledgerRowsExistForRef(reversalRef)) {
    devWarn(`[Ledger] Reversal already posted for ${originalRef}`);
    try {
      track(METRICS.LEDGER_DUPLICATE_PREVENTED, 1, { layer: 'reversal_ref' });
    } catch {
      /* non-fatal */
    }
    return { txRef: reversalRef, idempotent: true };
  }

  const localOrig = findLocalEntriesByTransactionRef(originalRef);
  let remoteOrig = [];
  try {
    remoteOrig = await ledgerService.fetchEntriesByTransactionRef(originalRef);
  } catch {
    remoteOrig = [];
  }
  const originals = mergeLedgerArrays(localOrig, remoteOrig, null);
  if (!originals || originals.length === 0) {
    throw new Error(`LEDGER_REVERSAL: No entries found for txRef ${originalRef}`);
  }

  const origDebit = originals.find((e) => e.entryType === ENTRY_TYPE.DEBIT);
  const origCredit = originals.find((e) => e.entryType === ENTRY_TYPE.CREDIT);

  if (!origDebit || !origCredit) {
    throw new Error(`LEDGER_REVERSAL: Incomplete original transaction — missing debit or credit leg`);
  }

  const senderBalance = await deriveBalance(origDebit.accountPhone);
  const recipientBalance = await deriveBalance(origCredit.accountPhone);

  // =====================================================
  // Build reversal payloads
  // =====================================================

  const revDebitBalanceBefore = round(recipientBalance);
  const revDebitBalanceAfter = round(revDebitBalanceBefore - origCredit.amount);
  const revCreditBalanceBefore = round(senderBalance);
  const revCreditBalanceAfter = round(revCreditBalanceBefore + origDebit.amount);

  const revDebitForRpc = {
    transactionRef: reversalRef,
    amount: origCredit.amount,
    balanceBefore: revDebitBalanceBefore,
    balanceAfter: revDebitBalanceAfter,
    accountPhone: origCredit.accountPhone,
    description: `${reason} of ${originalRef}`,
    owner: owner ?? null,
    idempotencyKey: null,
    hash: '',
  };

  const revCreditForRpc = {
    transactionRef: reversalRef,
    amount: origDebit.amount,
    balanceBefore: revCreditBalanceBefore,
    balanceAfter: revCreditBalanceAfter,
    accountPhone: origDebit.accountPhone,
    description: `${reason} of ${originalRef}`,
    owner: owner ?? null,
    idempotencyKey: null,
    hash: '',
  };

  // =====================================================
  // Compute hashes
  // =====================================================

  revDebitForRpc.hash = await computeHash({ ...revDebitForRpc, entryType: ENTRY_TYPE.DEBIT });
  revCreditForRpc.hash = await computeHash({ ...revCreditForRpc, entryType: ENTRY_TYPE.CREDIT });

  // =====================================================
  // Atomic reversal write — both succeed or both roll back
  // =====================================================

  await postDoubleEntryAtomic(revDebitForRpc, revCreditForRpc);

  // =====================================================
  // Local offline mirror — runs ONLY after successful RPC
  // =====================================================

  let revDebit;
  let revCredit;

  try {
    revDebit = appendLocalLedgerEntry({
      ...revDebitForRpc,
      entryType: ENTRY_TYPE.DEBIT,
      _source: 'local',
    });

    revCredit = appendLocalLedgerEntry({
      ...revCreditForRpc,
      entryType: ENTRY_TYPE.CREDIT,
      _source: 'local',
    });
  } catch (err) {
    devWarn('[Ledger] reversal local mirror failed (non-fatal):', err);
  }

  if (import.meta.env.DEV) {
    console.info(`[Ledger] Reversal posted ${reversalRef} for original ${originalRef}`);
  }
  return { txRef: reversalRef, revCredit, revDebit, idempotent: false };
}

export async function runReconciliation() {
  const runDate = new Date().toISOString().slice(0, 10);

  let totalDebits = 0;
  let totalCredits = 0;
  let entriesChecked = 0;
  let status = 'pending';

  const localFlat = readAllLocalLedgerEntries();

  let remote = [];
  try {
    remote = await ledgerService.listLedger('created_date', 5000);
  } catch {
    remote = [];
  }

  const entries = mergeLedgerArrays(localFlat, remote, null);

  for (const entry of entries) {
    if (entry.entryType === ENTRY_TYPE.DEBIT) totalDebits = round(totalDebits + entry.amount);
    if (entry.entryType === ENTRY_TYPE.CREDIT) totalCredits = round(totalCredits + entry.amount);
    entriesChecked++;
  }

  const difference = round(Math.abs(totalDebits - totalCredits));
  status = difference === 0 ? 'balanced' : 'discrepancy';

  if (difference !== 0) {
    try {
      track(METRICS.LEDGER_RECON_MISMATCH, 1, { diff: String(difference) });
    } catch {
      /* non-fatal */
    }
  }

  const log = await reconciliationService.createReconciliationLog({
    runDate,
    totalDebits,
    totalCredits,
    difference,
    status,
    entriesChecked,
  });

  if (import.meta.env.DEV) {
    console.info(`[Ledger] Reconciliation ${status} — ${entriesChecked} entries, diff: ${difference}`);
  }
  return log;
}

export async function getStatement(accountPhone, limit = 100) {
  const phone = String(accountPhone || '');
  const merged = await loadMergedAccountEntries(phone);
  const sorted = [...merged].sort(
    (a, b) =>
      (Date.parse(String(b.created_date || '')) || 0) -
      (Date.parse(String(a.created_date || '')) || 0)
  );
  return sorted.slice(0, limit).map((e) => ({
    ref: e.transactionRef,
    date: e.created_date,
    type: e.entryType,
    amount: e.amount,
    balance: e.balanceAfter,
    description: e.description,
    hash: e.hash,
  }));
}
