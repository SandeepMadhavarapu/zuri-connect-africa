import { describe, it, expect } from 'vitest';
import {
  round,
  validatePair,
  validateEntry,
  ENTRY_TYPE,
  generateReversalRef,
  computeHash,
} from '@/lib/ledger.js';

describe('ledger engine', () => {
  it('round handles float drift', () => {
    expect(round(1.005)).toBe(1.01);
    expect(round(10.999)).toBe(11);
  });

  it('validatePair enforces double-entry match', () => {
    const debit = {
      transactionRef: 'TX-1',
      entryType: ENTRY_TYPE.DEBIT,
      amount: 100,
    };
    const credit = {
      transactionRef: 'TX-1',
      entryType: ENTRY_TYPE.CREDIT,
      amount: 100,
    };
    expect(() => validatePair(debit, credit)).not.toThrow();
  });

  it('validatePair rejects amount mismatch', () => {
    expect(() =>
      validatePair(
        { transactionRef: 'TX', entryType: ENTRY_TYPE.DEBIT, amount: 50 },
        { transactionRef: 'TX', entryType: ENTRY_TYPE.CREDIT, amount: 51 }
      )
    ).toThrow(/LEDGER_PAIR/);
  });

  it('validateEntry rejects invalid balance math', () => {
    expect(() =>
      validateEntry({
        transactionRef: 'r',
        entryType: ENTRY_TYPE.DEBIT,
        amount: 10,
        balanceBefore: 100,
        balanceAfter: 95,
        accountPhone: '+2547',
      })
    ).toThrow(/LEDGER_INTEGRITY/);
  });

  it('generateReversalRef prefixes original', () => {
    expect(generateReversalRef('TXN-ABC')).toBe('REV-TXN-ABC');
  });

  it('computeHash is deterministic', async () => {
    const fields = {
      transactionRef: 'TX',
      entryType: 'debit',
      amount: 10,
      balanceBefore: 100,
      balanceAfter: 90,
      accountPhone: '2547',
    };
    const a = await computeHash(fields);
    const b = await computeHash(fields);
    expect(a).toBe(b);
    expect(a.length).toBe(64);
  });
});
