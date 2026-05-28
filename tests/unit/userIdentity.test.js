import { describe, it, expect } from 'vitest';
import { resolveLedgerIdentity, resolveLedgerIdentityWithFallback, LEGACY_DEMO_LEDGER_KEY } from '@/lib/userIdentity.js';

describe('userIdentity', () => {
  it('prefers phone over email', () => {
    expect(resolveLedgerIdentity({ phone: '+2547', email: 'a@b.com' })).toBe('+2547');
  });

  it('falls back to legacy demo key when empty', () => {
    expect(resolveLedgerIdentityWithFallback({})).toBe(LEGACY_DEMO_LEDGER_KEY);
  });
});
