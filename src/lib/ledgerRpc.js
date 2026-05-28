/**
 * ZuriConnect Africa — Atomic Ledger RPC
 *
 * Calls the post_double_entry Postgres function which wraps
 * both ledger inserts in a single atomic database transaction.
 *
 * If either insert fails:
 *   - the entire transaction rolls back
 *   - no one-legged ledger entries are created
 *   - no reconciliation drift occurs
 */

import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { devWarn } from '@/lib/devLog.js';
import { assertClientLedgerPostingAllowed } from '@/lib/clientLedgerGuard.js';

/**
 * Post a debit and credit atomically via Postgres RPC.
 *
 * @param {object} debitEntry  - normalized ledger entry (debit side)
 * @param {object} creditEntry - normalized ledger entry (credit side)
 * @returns {Promise<{ ok: boolean, transaction_ref: string, debit_id: string, credit_id: string }>}
 * @throws {Error} LEDGER_ATOMIC_FAIL if the RPC fails
 */
export async function postDoubleEntryAtomic(debitEntry, creditEntry, expectedBalanceBefore = null) {
  assertClientLedgerPostingAllowed();

  const supabase = getSupabaseBrowserClient();

  const debitPayload = {
    transaction_ref: debitEntry.transactionRef,
    amount: String(debitEntry.amount),
    balance_before: String(debitEntry.balanceBefore),
    balance_after: String(debitEntry.balanceAfter),
    account_phone: debitEntry.accountPhone,
    description: debitEntry.description ?? '',
    hash: debitEntry.hash ?? '',
    owner_id: debitEntry.owner ?? null,
    idempotency_key: debitEntry.idempotencyKey ?? null,
  };

  const creditPayload = {
    transaction_ref: creditEntry.transactionRef,
    amount: String(creditEntry.amount),
    balance_before: String(creditEntry.balanceBefore),
    balance_after: String(creditEntry.balanceAfter),
    account_phone: creditEntry.accountPhone,
    description: creditEntry.description ?? '',
    hash: creditEntry.hash ?? '',
    owner_id: creditEntry.owner ?? null,
    idempotency_key: creditEntry.idempotencyKey ?? null,
  };

  const { data, error } = await supabase.rpc('post_double_entry', {
    p_debit:                       debitPayload,
    p_credit:                      creditPayload,
    p_expect_debit_balance_before: expectedBalanceBefore,
  });

  if (error) {
    devWarn('[LedgerRpc] post_double_entry failed:', error.message);
    throw new Error(`LEDGER_ATOMIC_FAIL: ${error.message}`);
  }

  if (!data?.ok) {
    throw new Error('LEDGER_ATOMIC_FAIL: RPC returned ok=false with no error detail');
  }

  // Best-effort: sync balance_cached on the sender's wallet record.
  // Non-blocking — if this fails, the ledger is still correct.
  // balance_cached is a convenience cache for external reporting only.
  if (debitEntry.owner) {
    try {
      const supabase = getSupabaseBrowserClient();
      await supabase
        .from('wallets')
        .update({
          balance_cached: Number(debitEntry.balanceAfter),
          updated_at:     new Date().toISOString(),
        })
        .eq('user_id', debitEntry.owner);
    } catch (syncErr) {
      if (typeof window !== 'undefined' && import.meta?.env?.DEV) {
        console.warn('[LedgerRpc] balance_cached sync failed (non-fatal):', syncErr);
      }
    }
  }

  return data;
}
