import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/reconciliationService.js', () => ({}));

const fetchEntries = vi.fn();
const fetchEntriesByTransactionRef = vi.fn();
const persistEntry = vi.fn();
const postDoubleEntryAtomic = vi.fn();

vi.mock('@/lib/clientLedgerGuard.js', () => ({
  assertClientLedgerPostingAllowed: vi.fn(),
  isClientDemoLedgerAllowed: () => true,
}));

vi.mock('@/lib/ledgerRpc.js', () => ({
  postDoubleEntryAtomic: (...a) => postDoubleEntryAtomic(...a),
}));

vi.mock('@/services/ledgerService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchEntries: (...a) => fetchEntries(...a),
    fetchEntriesByTransactionRef: (...a) => fetchEntriesByTransactionRef(...a),
    persistEntry: (...a) => persistEntry(...a),
    listLedger: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@/lib/settlementEngine.js', () => ({
  queueSettlement: vi.fn(),
  runSettlementQueue: vi.fn(),
}));

import { postTransaction, ENTRY_TYPE } from '@/lib/ledger.js';
import { clearExpiredKeys } from '@/lib/idempotency.js';
import { __clearLocalLedgerTestState } from '@/lib/localLedgerStore.js';

describe('rapid sequential retries — idempotency wins', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    __clearLocalLedgerTestState();
    clearExpiredKeys();

    fetchEntriesByTransactionRef.mockResolvedValue([]);

    fetchEntries.mockImplementation(async (phone) => {
      const p = String(phone || '');
      if (p === '+254CONC1') {
        return [
          {
            transactionRef: 'SEED',
            entryType: ENTRY_TYPE.CREDIT,
            amount: 1,
            balanceBefore: 0,
            balanceAfter: 50000,
            accountPhone: '+254CONC1',
            hash: 'a',
            created_date: new Date().toISOString(),
          },
        ];
      }
      if (p === '+254CONC2') return [];
      return [];
    });

    persistEntry.mockResolvedValue({ ok: true });
    postDoubleEntryAtomic.mockResolvedValue({ ok: true, transaction_ref: 'ok', debit_id: 'd', credit_id: 'c' });
  });

  it('fifteen sequential submits with same idempotency key yield one debit/credit pair', async () => {
    const iKey = `zuri_storm_${Date.now()}`;
    const results = [];
    for (let i = 0; i < 15; i++) {
      results.push(
        await postTransaction({
          fromPhone: '+254CONC1',
          toPhone: '+254CONC2',
          amount: 10,
          txRef: `STORM-${i}`,
          owner: 'user-1',
          idempotencyKey: iKey,
        })
      );
    }

    expect(results.filter((r) => !r.replayed).length).toBe(1);
    expect(results.filter((r) => r.replayed).length).toBe(14);
    expect(postDoubleEntryAtomic.mock.calls.length).toBe(1);
  });
});
