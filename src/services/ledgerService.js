import { fromTable } from '@/lib/supabase/database.js';
import { isSupabaseConfigured } from '@/config/env.js';
import { track, METRICS } from '@/lib/observability/metrics.js';
import {
  assertClientLedgerPostingAllowed,
  clientLedgerForbiddenResult,
  isClientDemoLedgerAllowed,
} from '@/lib/clientLedgerGuard.js';

const TABLE = 'ledger_entries';

function snakeMatch(q) {
  const map = {
    transactionRef: 'transaction_ref',
    accountPhone: 'account_phone',
    entryType: 'entry_type',
  };
  const out = {};
  Object.entries(q || {}).forEach(([k, v]) => {
    out[map[k] || k] = v;
  });
  return out;
}

export function mapLedgerRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    transactionRef: row.transaction_ref,
    entryType: row.entry_type,
    amount: Number(row.amount),
    balanceBefore: Number(row.balance_before),
    balanceAfter: Number(row.balance_after),
    accountPhone: row.account_phone,
    description: row.description ?? '',
    hash: row.hash,
    owner: row.owner_id ?? row.owner,
    created_date: row.created_at,
    _localSeq: row._localSeq ?? 0,
    _source: row._source ?? 'remote',
  };
}

function parseOrder(sortField, fallbackColumn = 'created_at') {
  if (!sortField) return { column: fallbackColumn, ascending: true };
  const desc = String(sortField).startsWith('-');
  const raw = desc ? sortField.slice(1) : sortField;
  const colMap = {
    created_date: 'created_at',
    transactionRef: 'transaction_ref',
  };
  const column = colMap[raw] || raw;
  return { column, ascending: !desc };
}

/**
 * Remote-only filter (legacy / admin tooling). Safe fallback: empty on failure.
 */
export async function filterLedger(match, sortField, limit = 1000) {
  try {
    if (!isSupabaseConfigured) return [];
    const sb = snakeMatch(match);
    let q = fromTable(TABLE).select('*');
    Object.entries(sb).forEach(([k, v]) => {
      q = q.eq(k, v);
    });
    const { column, ascending } = parseOrder(sortField);
    q = q.order(column, { ascending });
    if (limit) q = q.limit(limit);
    const { data, error } = await q;
    if (error) return [];
    return (data || []).map(mapLedgerRow);
  } catch {
    return [];
  }
}

export async function listLedger(sortField, limit = 1000) {
  try {
    if (!isSupabaseConfigured) return [];
    const { column, ascending } = parseOrder(sortField);
    const { data, error } = await fromTable(TABLE)
      .select('*')
      .order(column, { ascending })
      .limit(limit);
    if (error) return [];
    return (data || []).map(mapLedgerRow);
  } catch {
    return [];
  }
}

export async function createLedgerEntry(payload) {
  assertClientLedgerPostingAllowed();

  const row = {
    transaction_ref: payload.transactionRef,
    entry_type: payload.entryType,
    amount: payload.amount,
    balance_before: payload.balanceBefore,
    balance_after: payload.balanceAfter,
    account_phone: payload.accountPhone,
    description: payload.description ?? '',
    hash: payload.hash,
    owner_id: payload.owner || null,
  };
  const { data, error } = await fromTable(TABLE).insert(row).select('*').single();
  if (error) throw error;
  return mapLedgerRow(data);
}

/**
 * Idempotent remote write. Production browser callers receive an explicit
 * forbidden result; only local demo controls may write ledger rows from client code.
 * @param {object} payload
 * @returns {Promise<{ ok: boolean, skipped?: boolean, forbidden?: boolean }>}
 */
export async function persistEntry(payload) {
  try {
    if (!isClientDemoLedgerAllowed()) {
      return clientLedgerForbiddenResult();
    }

    if (!isSupabaseConfigured) {
      return { ok: false, skipped: true };
    }
    const row = {
      transaction_ref: payload.transactionRef,
      entry_type: payload.entryType,
      amount: payload.amount,
      balance_before: payload.balanceBefore,
      balance_after: payload.balanceAfter,
      account_phone: payload.accountPhone,
      description: payload.description ?? '',
      hash: payload.hash,
      owner_id: payload.owner ?? payload.owner_id ?? null,
      idempotency_key: payload.idempotencyKey ?? payload.idempotency_key ?? null,
    };
    const { error } = await fromTable(TABLE).upsert(row, {
      onConflict: 'transaction_ref,entry_type',
    });
    if (error) {
      track(METRICS.LEDGER_PERSIST_FAILURE, 1, { c: String(error.code || 'e') });
      return { ok: false };
    }
    return { ok: true };
  } catch {
    track(METRICS.LEDGER_PERSIST_FAILURE, 1, { c: 'x' });
    return { ok: false };
  }
}

/**
 * Newest-first remote rows for an account. Never throws.
 * @param {string} accountPhone
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function fetchEntries(accountPhone, opts = {}) {
  const limit = opts.limit ?? 2000;
  try {
    if (!isSupabaseConfigured) return [];
    const phone = String(accountPhone || '');
    if (!phone) return [];
    const { data, error } = await fromTable(TABLE)
      .select('*')
      .eq('account_phone', phone)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data || []).map(mapLedgerRow);
  } catch {
    return [];
  }
}

/**
 * Remote rows for a transaction reference. Never throws.
 * @param {string} transactionRef
 * @returns {Promise<object[]>}
 */
export async function fetchEntriesByTransactionRef(transactionRef) {
  try {
    if (!isSupabaseConfigured) return [];
    const ref = String(transactionRef || '');
    if (!ref) return [];
    const { data, error } = await fromTable(TABLE).select('*').eq('transaction_ref', ref);
    if (error) return [];
    return (data || []).map(mapLedgerRow);
  } catch {
    return [];
  }
}

/**
 * Authoritative balance from entry chain only (no mutable wallet fields).
 * @param {object[]} entries normalized ledger rows
 * @param {string} accountPhone
 * @returns {{ balance: number, meta: { entryCount: number } }}
 */
export function deriveBalanceFromEntries(entries, accountPhone) {
  const phone = String(accountPhone || '');
  const mine = (entries || []).filter((e) => String(e.accountPhone) === phone);
  if (mine.length === 0) return { balance: 0, meta: { entryCount: 0 } };
  const sorted = [...mine].sort((a, b) => {
    const ta = Date.parse(String(a.created_date || '')) || 0;
    const tb = Date.parse(String(b.created_date || '')) || 0;
    if (ta !== tb) return ta - tb;
    return (a._localSeq || 0) - (b._localSeq || 0);
  });
  const last = sorted[sorted.length - 1];
  return { balance: last.balanceAfter, meta: { entryCount: sorted.length } };
}
