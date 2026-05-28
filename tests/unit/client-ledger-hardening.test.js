import { beforeEach, describe, expect, it, vi } from 'vitest';

const fromTable = vi.hoisted(() => vi.fn());
const ledgerPostTransaction = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabase/database.js', () => ({
  fromTable,
}));

vi.mock('@/config/env.js', () => ({
  isSupabaseConfigured: true,
}));

vi.mock('@/lib/ledger', () => ({
  postTransaction: (...args) => ledgerPostTransaction(...args),
}));

vi.mock('@/lib/observability', () => ({
  obs: {
    startTrace: () => ({ traceId: 'trace-1' }),
    info: vi.fn(),
    error: vi.fn(),
    track: vi.fn(),
    endTrace: vi.fn(),
  },
  METRICS: {
    LEDGER_POST_COUNT: 'ledger_post_count',
  },
}));

vi.mock('@/lib/eventBus', () => ({
  emit: vi.fn(),
  EVENTS: { LEDGER_POSTED: 'LEDGER_POSTED' },
}));

vi.mock('@/lib/auditLogger', () => ({
  audit: { reconciliationRun: vi.fn() },
}));

import { createLedgerEntry, persistEntry } from '@/services/ledgerService.js';
import { postTransaction as apiPostTransaction } from '@/api/ledger.js';

const ledgerPayload = {
  transactionRef: 'TX-CLIENT-GUARD',
  entryType: 'debit',
  amount: 10,
  balanceBefore: 100,
  balanceAfter: 90,
  accountPhone: '+254700000001',
  description: 'guard test',
  hash: '0'.repeat(64),
  owner: 'user-1',
};

function setEnv({ appEnv = 'production', allow = 'false', strict = 'true' } = {}) {
  vi.stubEnv('VITE_APP_ENV', appEnv);
  vi.stubEnv('VITE_ALLOW_CLIENT_DEMO_CONTROLS', allow);
  vi.stubEnv('VITE_STRICT_ENV', strict);
}

function mockLedgerTable() {
  const insertedRow = {
    id: 'row-1',
    transaction_ref: ledgerPayload.transactionRef,
    entry_type: ledgerPayload.entryType,
    amount: ledgerPayload.amount,
    balance_before: ledgerPayload.balanceBefore,
    balance_after: ledgerPayload.balanceAfter,
    account_phone: ledgerPayload.accountPhone,
    description: ledgerPayload.description,
    hash: ledgerPayload.hash,
    owner_id: ledgerPayload.owner,
    created_at: '2026-05-18T12:00:00.000Z',
  };
  const single = vi.fn().mockResolvedValue({ data: insertedRow, error: null });
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const upsert = vi.fn().mockResolvedValue({ error: null });
  fromTable.mockReturnValue({ insert, upsert });
  return { insert, select, single, upsert };
}

describe('client ledger hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('ledgerService.createLedgerEntry refuses in production browser mode', async () => {
    setEnv({ appEnv: 'production', allow: 'false', strict: 'true' });

    await expect(createLedgerEntry(ledgerPayload)).rejects.toThrow(/CLIENT_LEDGER_FORBIDDEN/);
    expect(fromTable).not.toHaveBeenCalled();
  });

  it('ledgerService.persistEntry refuses in staging browser mode without attempting an upsert', async () => {
    setEnv({ appEnv: 'staging', allow: 'true', strict: 'true' });

    const result = await persistEntry(ledgerPayload);

    expect(result).toMatchObject({
      ok: false,
      skipped: true,
      forbidden: true,
      error: 'CLIENT_LEDGER_FORBIDDEN',
    });
    expect(fromTable).not.toHaveBeenCalled();
  });

  it('src/api/ledger.js postTransaction refuses in production browser mode', async () => {
    setEnv({ appEnv: 'production', allow: 'true', strict: 'false' });

    await expect(apiPostTransaction({
      fromPhone: '+254700000001',
      toPhone: '+254700000002',
      amount: 10,
    })).rejects.toThrow(/src\/api\/ledger\.js postTransaction is local-demo only/);
    expect(ledgerPostTransaction).not.toHaveBeenCalled();
  });

  it('local demo mode allows ledgerService writes and api ledger posting only with explicit controls', async () => {
    setEnv({ appEnv: 'local', allow: 'true', strict: 'false' });
    const table = mockLedgerTable();
    ledgerPostTransaction.mockResolvedValue({ txRef: 'TX-LOCAL-DEMO' });

    const created = await createLedgerEntry(ledgerPayload);
    const persisted = await persistEntry(ledgerPayload);
    const posted = await apiPostTransaction({
      fromPhone: '+254700000001',
      toPhone: '+254700000002',
      amount: 10,
    });

    expect(created.transactionRef).toBe(ledgerPayload.transactionRef);
    expect(persisted).toEqual({ ok: true });
    expect(posted).toEqual({ txRef: 'TX-LOCAL-DEMO' });
    expect(table.insert).toHaveBeenCalledTimes(1);
    expect(table.upsert).toHaveBeenCalledTimes(1);
    expect(ledgerPostTransaction).toHaveBeenCalledTimes(1);
  });

  it('local demo mode is disabled when strict env is true', async () => {
    setEnv({ appEnv: 'local', allow: 'true', strict: 'true' });

    const result = await persistEntry(ledgerPayload);
    await expect(createLedgerEntry(ledgerPayload)).rejects.toThrow(/CLIENT_LEDGER_FORBIDDEN/);
    await expect(apiPostTransaction({
      fromPhone: '+254700000001',
      toPhone: '+254700000002',
      amount: 10,
    })).rejects.toThrow(/CLIENT_LEDGER_FORBIDDEN/);

    expect(result.forbidden).toBe(true);
    expect(fromTable).not.toHaveBeenCalled();
    expect(ledgerPostTransaction).not.toHaveBeenCalled();
  });
});
