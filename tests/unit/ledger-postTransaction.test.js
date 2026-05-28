import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/services/reconciliationService.js', () => ({}));

const fetchEntries = vi.fn();
const fetchEntriesByTransactionRef = vi.fn();
const persistEntry = vi.fn();
const listLedger = vi.fn();
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
    listLedger: (...a) => listLedger(...a),
  };
});

vi.mock('@/lib/settlementEngine.js', () => ({
  queueSettlement: vi.fn(),
  runSettlementQueue: vi.fn(),
}));

import { postTransaction, reverseTransaction, deriveBalance, ENTRY_TYPE } from '@/lib/ledger.js';
import { clearExpiredKeys } from '@/lib/idempotency.js';
import { __clearLocalLedgerTestState } from '@/lib/localLedgerStore.js';

describe('postTransaction integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    localStorage.clear();
    __clearLocalLedgerTestState();
    clearExpiredKeys();

    persistEntry.mockResolvedValue({ ok: true });
    postDoubleEntryAtomic.mockResolvedValue({ ok: true, transaction_ref: 'ok', debit_id: 'd', credit_id: 'c' });
    listLedger.mockResolvedValue([]);

    fetchEntries.mockImplementation(async (phone) => {
      const p = String(phone || '');
      if (p === '+254700000001') {
        return [
          {
            transactionRef: 'PREV',
            entryType: ENTRY_TYPE.CREDIT,
            amount: 10,
            balanceBefore: 0,
            balanceAfter: 1000,
            accountPhone: '+254700000001',
            hash: 'x',
            created_date: new Date().toISOString(),
          },
        ];
      }
      if (p === '+254700000002') return [];
      if (p === '+254POOR') {
        return [
          {
            transactionRef: 'OLD',
            entryType: ENTRY_TYPE.DEBIT,
            amount: 5,
            balanceBefore: 10,
            balanceAfter: 5,
            accountPhone: '+254POOR',
            hash: 'h1',
            created_date: new Date().toISOString(),
          },
        ];
      }
      if (p === '+254RICH') return [];
      return [];
    });

    fetchEntriesByTransactionRef.mockImplementation(async (transactionRef) => {
      const r = String(transactionRef || '');
      if (r === 'EXISTING-TX') {
        return [
          {
            transactionRef: 'EXISTING-TX',
            entryType: ENTRY_TYPE.DEBIT,
            amount: 50,
            balanceBefore: 150,
            balanceAfter: 100,
            accountPhone: '+254700000001',
            hash: 'a',
            created_date: new Date().toISOString(),
          },
          {
            transactionRef: 'EXISTING-TX',
            entryType: ENTRY_TYPE.CREDIT,
            amount: 50,
            balanceBefore: 0,
            balanceAfter: 50,
            accountPhone: '+254700000002',
            hash: 'b',
            created_date: new Date().toISOString(),
          },
        ];
      }
      if (r === 'REV-REV-ORIG') {
        return [{ entryType: ENTRY_TYPE.DEBIT }];
      }
      return [];
    });
  });

  it('rejects insufficient funds without writing', async () => {
    await expect(
      postTransaction({
        fromPhone: '+254POOR',
        toPhone: '+254RICH',
        amount: 100,
        txRef: 'TX-INSUFFICIENT',
        owner: 'u1',
      })
    ).rejects.toThrow(/LEDGER_FUNDS/);

    expect(postDoubleEntryAtomic).not.toHaveBeenCalled();
  });

  it('returns idempotent result when transaction_ref already exists', async () => {
    const r = await postTransaction({
      fromPhone: '+254700000001',
      toPhone: '+254700000002',
      amount: 50,
      txRef: 'EXISTING-TX',
      owner: 'u1',
    });
    expect(r.idempotent).toBe(true);
    expect(r.txRef).toBe('EXISTING-TX');
    expect(postDoubleEntryAtomic).not.toHaveBeenCalled();
  });

  it('double-submit with same idempotency key returns replay without second write', async () => {
    const iKey = 'zuri_idmp_stress_test_key';
    const first = await postTransaction({
      fromPhone: '+254700000001',
      toPhone: '+254700000002',
      amount: 25,
      txRef: 'TX-FIRST-UNIQUE',
      owner: 'u1',
      idempotencyKey: iKey,
    });
    expect(first.replayed).toBeUndefined();

    const writesAfterFirst = postDoubleEntryAtomic.mock.calls.length;
    const second = await postTransaction({
      fromPhone: '+254700000001',
      toPhone: '+254700000002',
      amount: 25,
      txRef: 'TX-SECOND-SHOULD-NOT-MATTER',
      owner: 'u1',
      idempotencyKey: iKey,
    });
    expect(second.replayed).toBe(true);
    expect(postDoubleEntryAtomic.mock.calls.length).toBe(writesAfterFirst);
  });
});

describe('deriveBalance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearLocalLedgerTestState();
    fetchEntries.mockResolvedValue([
      {
        transactionRef: 'T',
        entryType: ENTRY_TYPE.DEBIT,
        amount: 1,
        balanceBefore: 101,
        balanceAfter: 100,
        accountPhone: '+254X',
        hash: 'z',
        created_date: new Date().toISOString(),
      },
    ]);
  });

  it('reads latest balanceAfter for account', async () => {
    const b = await deriveBalance('+254X');
    expect(b).toBe(100);
    expect(fetchEntries).toHaveBeenCalledWith('+254X', { limit: 5000 });
  });
});

describe('reverseTransaction safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearLocalLedgerTestState();
    persistEntry.mockResolvedValue({ ok: true });
    listLedger.mockResolvedValue([]);

    fetchEntries.mockImplementation(async (phone) => {
      const p = String(phone || '');
      if (p === 'A') {
        return [
          {
            balanceAfter: 80,
            entryType: ENTRY_TYPE.DEBIT,
            amount: 20,
            accountPhone: 'A',
            transactionRef: 'R',
            balanceBefore: 100,
            hash: 'h',
            created_date: new Date().toISOString(),
          },
        ];
      }
      if (p === 'B') {
        return [
          {
            balanceAfter: 20,
            entryType: ENTRY_TYPE.CREDIT,
            amount: 20,
            accountPhone: 'B',
            transactionRef: 'R',
            balanceBefore: 0,
            hash: 'h2',
            created_date: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    fetchEntriesByTransactionRef.mockImplementation(async (ref) => {
      if (ref === 'REV-REV-ORIG') {
        return [{ entryType: ENTRY_TYPE.DEBIT }];
      }
      if (ref === 'REV-ORIG') {
        return [
          {
            transactionRef: 'REV-ORIG',
            entryType: ENTRY_TYPE.DEBIT,
            amount: 20,
            balanceBefore: 100,
            balanceAfter: 80,
            accountPhone: 'A',
            hash: '1',
            created_date: new Date().toISOString(),
          },
          {
            transactionRef: 'REV-ORIG',
            entryType: ENTRY_TYPE.CREDIT,
            amount: 20,
            balanceBefore: 0,
            balanceAfter: 20,
            accountPhone: 'B',
            hash: '2',
            created_date: new Date().toISOString(),
          },
        ];
      }
      return [];
    });
  });

  it('is idempotent when reversal already posted', async () => {
    const r = await reverseTransaction('REV-ORIG', 'test', 'u');
    expect(r.idempotent).toBe(true);
  });
});
