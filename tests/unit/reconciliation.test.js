import { describe, it, expect, vi } from 'vitest';
import { replayLedger } from '@/backend/reconciliation/reconciliationEngine.js';

vi.mock('@/services/ledgerService.js', () => ({}));
vi.mock('@/services/reconciliationService.js', () => ({}));
vi.mock('@/lib/settlementEngine.js', () => ({
  getAllSettlements: () => ({}),
  SETTLEMENT_STATUS: { PENDING: 'pending' },
}));
vi.mock('@/lib/eventBus.js', () => ({ emit: vi.fn() }));
vi.mock('@/lib/observability', () => ({
  obs: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('reconciliation replayLedger', () => {
  it('balances debits and credits for valid entries', async () => {
    const entries = [
      {
        transactionRef: 'T1',
        entryType: 'debit',
        amount: 50,
        balanceBefore: 100,
        balanceAfter: 50,
        accountPhone: 'A',
        hash: '',
      },
      {
        transactionRef: 'T1',
        entryType: 'credit',
        amount: 50,
        balanceBefore: 0,
        balanceAfter: 50,
        accountPhone: 'B',
        hash: '',
      },
    ];
    const r = await replayLedger(entries);
    expect(r.balanced).toBe(true);
    expect(r.entriesChecked).toBe(2);
  });
});
