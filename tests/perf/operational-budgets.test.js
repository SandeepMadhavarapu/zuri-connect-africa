import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/ledgerService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    fetchEntries: vi.fn().mockResolvedValue([]),
    fetchEntriesByTransactionRef: vi.fn().mockResolvedValue([]),
    persistEntry: vi.fn().mockResolvedValue({ ok: true }),
    listLedger: vi.fn().mockResolvedValue([]),
  };
});

import { computeHash, deriveBalance } from '@/lib/ledger.js';

describe('operational performance budgets (local, jsdom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ledger hash: 200 SHA-256 digests complete within budget', async () => {
    const started = performance.now();
    const entry = {
      transactionRef: 'PERF-TX',
      entryType: 'debit',
      amount: 10,
      balanceBefore: 100,
      balanceAfter: 90,
      accountPhone: '+254700000001',
    };
    for (let i = 0; i < 200; i++) {
      await computeHash({ ...entry, transactionRef: `PERF-TX-${i}` });
    }
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(800);
  });

  it('deriveBalance with empty history resolves within budget', async () => {
    const started = performance.now();
    await deriveBalance('+254700000099');
    const ms = performance.now() - started;
    expect(ms).toBeLessThan(400);
  });
});
