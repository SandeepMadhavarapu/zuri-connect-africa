import { isSupabaseConfigured } from '@/config/env.js';
import { fetchEntries } from '@/services/ledgerService.js';
import { mergeLedgerArrays } from '@/lib/ledgerMerge.js';
import { getLocalEntriesForAccountPhone } from '@/lib/localLedgerStore.js';

function inferTypeFromDescription(desc, entryType, amountSign) {
  const d = String(desc || '').toLowerCase();
  if (d.includes('airtime')) return 'airtime';
  if (d.includes('bundle')) return 'bundle';
  if (d.includes('fuliza')) return 'fuliza';
  if (d.includes('paybill') || d.includes('kenya power') || d.includes('nairobi water')) return 'paybill';
  if (entryType === 'credit' || amountSign > 0) return 'receive';
  return 'send';
}

/**
 * Merge M-PESA session history with immutable ledger legs for this device (local + optional remote).
 * Dedupes by transaction ref; preserves offline-only mpesa rows; newest-first ordering.
 * @param {string} accountPhone
 * @param {object[]} mpesaTransactions
 * @returns {Promise<object[]>}
 */
export async function loadMergedDisplayTransactions(accountPhone, mpesaTransactions) {
  const phone = String(accountPhone || '');
  const local = phone ? getLocalEntriesForAccountPhone(phone) : [];
  let remote = [];
  if (phone && isSupabaseConfigured) {
    try {
      remote = await fetchEntries(phone, { limit: 2000 });
    } catch {
      remote = [];
    }
  }
  const merged = mergeLedgerArrays(local, remote, null);
  const byRef = new Map();
  for (const e of merged) {
    if (String(e.accountPhone) !== phone) continue;
    const ref = String(e.transactionRef || '');
    if (!ref) continue;
    if (!byRef.has(ref)) byRef.set(ref, []);
    byRef.get(ref).push(e);
  }
  const fromLedger = [];
  for (const [ref, legs] of byRef) {
    const mine = legs.sort(
      (a, b) => (Date.parse(String(a.created_date || '')) || 0) - (Date.parse(String(b.created_date || '')) || 0)
    );
    const last = mine[mine.length - 1];
    if (!last) continue;
    const amt = last.entryType === 'debit' ? -Math.abs(Number(last.amount) || 0) : Math.abs(Number(last.amount) || 0);
    fromLedger.push({
      id: ref,
      type: inferTypeFromDescription(last.description, last.entryType, amt),
      name: last.description || (amt < 0 ? 'Sent' : 'Received'),
      amount: amt,
      date: last.created_date,
      ref,
      status: 'completed',
    });
  }
  fromLedger.sort((a, b) => (Date.parse(String(b.date || '')) || 0) - (Date.parse(String(a.date || '')) || 0));

  const mpesa = Array.isArray(mpesaTransactions) ? [...mpesaTransactions] : [];
  const seen = new Set(fromLedger.map((t) => String(t.id)));
  const out = [...fromLedger];
  for (const t of mpesa) {
    if (!t || t.id === undefined || t.id === null) continue;
    const id = String(t.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      ...t,
      ref: t.ref || id,
    });
  }
  out.sort((a, b) => (Date.parse(String(b.date || '')) || 0) - (Date.parse(String(a.date || '')) || 0));
  return out;
}
