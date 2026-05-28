/**
 * Durable local-first ledger mirror (browser).
 * Survives full page reloads; pairs with Supabase upsert for cross-device durability.
 */

import { assertClientLedgerPostingAllowed } from '@/lib/clientLedgerGuard.js';

const STORAGE_KEY = 'zuri_local_ledger_v1';
const SEQ_KEY = 'zuri_local_ledger_seq_v1';

/** @type {import('@/services/ledgerService.js').LedgerRowNormalized[] | null} */
let testMemory = null;
/** @type {number | null} */
let testSeq = null;

export function __setLocalLedgerTestState(entries, seq = 0) {
  testMemory = entries ? [...entries] : [];
  testSeq = seq;
}

export function __clearLocalLedgerTestState() {
  testMemory = null;
  testSeq = null;
}

function readRaw() {
  if (testMemory) return testMemory;
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRaw(entries) {
  if (testMemory !== null) {
    testMemory = [...entries];
    return;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    }
  } catch {
    /* quota / private mode — non-fatal */
  }
}

function nextSeq() {
  if (testSeq !== null) {
    testSeq += 1;
    return testSeq;
  }
  try {
    if (typeof localStorage === 'undefined') return Date.now();
    const cur = Number(localStorage.getItem(SEQ_KEY) || '0');
    const n = cur + 1;
    localStorage.setItem(SEQ_KEY, String(n));
    return n;
  } catch {
    return Date.now();
  }
}

/**
 * @param {object} e
 * @returns {string}
 */
export function ledgerEntryDedupeKey(e) {
  const ref = String(e.transactionRef ?? e.transaction_ref ?? '');
  const typ = String(e.entryType ?? e.entry_type ?? '');
  return `${ref}\0${typ}`;
}

/**
 * @returns {import('@/services/ledgerService.js').LedgerRowNormalized[]}
 */
export function readAllLocalLedgerEntries() {
  return readRaw().map(normalizeEntryShape);
}

/**
 * @param {import('@/services/ledgerService.js').LedgerRowNormalized} entry
 * @returns {import('@/services/ledgerService.js').LedgerRowNormalized}
 */
export function appendLocalLedgerEntry(entry) {
  assertClientLedgerPostingAllowed();
  const list = readRaw();
  const id =
    entry.id ||
    (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const created =
    entry.created_date ||
    entry.created_at ||
    new Date().toISOString();
  const row = normalizeEntryShape({
    ...entry,
    id,
    created_date: created,
    _localSeq: entry._localSeq ?? nextSeq(),
    _source: 'local',
  });
  const key = ledgerEntryDedupeKey(row);
  const idx = list.findIndex((x) => ledgerEntryDedupeKey(normalizeEntryShape(x)) === key);
  if (idx >= 0) {
    return normalizeEntryShape(list[idx]);
  }
  list.push(row);
  writeRaw(list);
  return normalizeEntryShape(row);
}

/**
 * @param {string} transactionRef
 * @returns {import('@/services/ledgerService.js').LedgerRowNormalized[]}
 */
export function findLocalEntriesByTransactionRef(transactionRef) {
  const ref = String(transactionRef || '');
  return readAllLocalLedgerEntries().filter((e) => String(e.transactionRef) === ref);
}

/**
 * @param {string} accountPhone
 * @returns {import('@/services/ledgerService.js').LedgerRowNormalized[]}
 */
export function getLocalEntriesForAccountPhone(accountPhone) {
  const phone = String(accountPhone || '');
  return readAllLocalLedgerEntries().filter((e) => String(e.accountPhone) === phone);
}

/**
 * @param {object} row
 * @returns {import('@/services/ledgerService.js').LedgerRowNormalized}
 */
function normalizeEntryShape(row) {
  if (!row || typeof row !== 'object') {
    return {
      id: '',
      transactionRef: '',
      entryType: 'debit',
      amount: 0,
      balanceBefore: 0,
      balanceAfter: 0,
      accountPhone: '',
      description: '',
      hash: '',
      owner: undefined,
      created_date: new Date(0).toISOString(),
      _localSeq: 0,
      _source: 'local',
    };
  }
  return {
    id: row.id,
    transactionRef: row.transactionRef ?? row.transaction_ref ?? '',
    entryType: row.entryType ?? row.entry_type ?? '',
    amount: Number(row.amount) || 0,
    balanceBefore: Number(row.balanceBefore ?? row.balance_before) || 0,
    balanceAfter: Number(row.balanceAfter ?? row.balance_after) || 0,
    accountPhone: row.accountPhone ?? row.account_phone ?? '',
    description: row.description ?? '',
    hash: row.hash ?? '',
    owner: row.owner ?? row.owner_id ?? undefined,
    created_date: row.created_date ?? row.created_at ?? new Date().toISOString(),
    _localSeq: row._localSeq ?? 0,
    _source: row._source ?? 'local',
  };
}
