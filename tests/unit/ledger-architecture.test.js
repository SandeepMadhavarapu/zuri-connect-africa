import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260519100000_ledger_accounts_and_hash_chain.sql'),
  'utf8',
);
const serverLedgerMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260518090000_server_authoritative_ledger.sql'),
  'utf8',
);
const ledgerService = readFileSync(
  resolve(process.cwd(), 'src/services/ledgerService.js'),
  'utf8',
);
const clientGuard = readFileSync(
  resolve(process.cwd(), 'src/lib/clientLedgerGuard.js'),
  'utf8',
);

const GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';

/** Mirrors public.compute_ledger_entry_hash in SQL (for chain verification tests). */
async function computeLedgerEntryHash(fields) {
  const raw = [
    fields.transactionRef ?? '',
    fields.entryType ?? '',
    String(fields.amount ?? ''),
    String(fields.balanceBefore ?? ''),
    String(fields.balanceAfter ?? ''),
    fields.accountPhone ?? '',
    fields.accountId ?? '',
    fields.idempotencyKey ?? '',
    fields.previousHash ?? GENESIS,
  ].join('|');
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashChainRows(rows) {
  const out = [];
  let prev = GENESIS;
  for (let i = 0; i < rows.length; i += 1) {
    const entryHash = await computeLedgerEntryHash({
      ...rows[i],
      previousHash: prev,
    });
    out.push({
      ...rows[i],
      chainIndex: BigInt(i + 1),
      previousHash: prev,
      entryHash,
    });
    prev = entryHash;
  }
  return out;
}

async function verifyChainLogic(rows) {
  let prev = GENESIS;
  let checked = 0;
  for (const row of rows) {
    checked += 1;
    if (row.chainIndex !== BigInt(checked)) {
      return { ok: false, reason: 'chain_index_gap', brokenAt: row.id, checkedCount: checked - 1 };
    }
    if (row.previousHash !== prev) {
      return { ok: false, reason: 'previous_hash_mismatch', brokenAt: row.id, checkedCount: checked - 1 };
    }
    const expected = await computeLedgerEntryHash({ ...row, previousHash: prev });
    if (row.entryHash !== expected) {
      return {
        ok: false,
        reason: 'entry_hash_mismatch',
        brokenAt: row.id,
        expectedHash: expected,
        actualHash: row.entryHash,
        checkedCount: checked - 1,
      };
    }
    prev = row.entryHash;
  }
  return { ok: true, checkedCount: checked };
}

describe('ledger architecture migration', () => {
  it('creates accounts table with required types and indexes', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.accounts/i);
    expect(migration).toMatch(/account_type.*wallet.*merchant.*paybill.*till.*savings.*fuliza.*settlement.*suspense.*fees/s);
    expect(migration).toMatch(/idx_accounts_user_id/i);
    expect(migration).toMatch(/idx_accounts_account_type/i);
    expect(migration).toMatch(/idx_accounts_external_identifier/i);
    expect(migration).toMatch(/idx_accounts_type_external_currency/i);
  });

  it('adds ledger_entries account + chain columns while preserving account_phone', () => {
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS account_id/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS debit_account_id/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS credit_account_id/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS previous_hash/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS entry_hash/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS chain_scope/i);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS chain_index/i);
    expect(migration).toMatch(/COMMENT ON COLUMN public\.ledger_entries\.hash IS/);
  });

  it('seeds system settlement/suspense/fees accounts', () => {
    expect(migration).toMatch(/SYSTEM:SETTLEMENT/);
    expect(migration).toMatch(/SYSTEM:SUSPENSE/);
    expect(migration).toMatch(/SYSTEM:FEES/);
  });

  it('resolve_or_create_account is service_role only', () => {
    expect(migration).toMatch(/resolve_or_create_account is service_role only/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.resolve_or_create_account/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.resolve_or_create_account.*TO service_role/s);
  });

  it('verify_ledger_chain is service_role only', () => {
    expect(migration).toMatch(/verify_ledger_chain is service_role only/i);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.verify_ledger_chain/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.verify_ledger_chain.*TO service_role/s);
  });

  it('post_double_entry resolves accounts and writes chain fields', () => {
    expect(migration).toMatch(/resolve_ledger_leg_account/);
    expect(migration).toMatch(/claim_ledger_chain_slot/);
    expect(migration).toMatch(/compute_ledger_entry_hash/);
    expect(migration).toMatch(/entry_hash, chain_scope, chain_index/);
    expect(migration).toMatch(/debit_account_id, credit_account_id/);
    expect(migration).toMatch(/IF v_debit_row\.id IS NULL THEN/);
    expect(migration).toMatch(/IF v_credit_row\.id IS NULL THEN/);
  });

  it('idempotent replay skips chain claim when row already exists', () => {
    expect(migration).toMatch(/FROM public\.ledger_entries[\s\S]*WHERE transaction_ref = p_debit->>'transaction_ref'/);
    expect(migration).toMatch(/entry_type = 'debit'/);
    expect(migration).toMatch(/entry_type = 'credit'/);
  });

  it('accounts RLS: users read own non-system; only service_role mutates', () => {
    expect(migration).toMatch(/accounts_select_own_non_system/);
    expect(migration).toMatch(/account_type NOT IN \('settlement', 'suspense', 'fees'\)/);
    expect(migration).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.accounts FROM anon, authenticated/);
    expect(migration).toMatch(/accounts_service_role_all/);
  });

  it('extends append-only trigger to include chain columns', () => {
    expect(migration).toMatch(/NEW\.entry_hash/);
    expect(migration).toMatch(/NEW\.chain_index/);
  });

  it('keeps server-authoritative ledger grants (post_double_entry service_role only)', () => {
    expect(serverLedgerMigration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.post_double_entry\(JSONB, JSONB, NUMERIC\) FROM PUBLIC, anon, authenticated/i);
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.post_double_entry\(JSONB, JSONB, NUMERIC\) FROM PUBLIC, anon, authenticated/i);
  });
});

describe('frontend cannot write accounts or ledger', () => {
  it('ledgerService calls client ledger guard before any table write', () => {
    expect(ledgerService).toMatch(/assertClientLedgerPostingAllowed/);
    expect(clientGuard).toMatch(/CLIENT_LEDGER_FORBIDDEN/);
  });

  it('clientLedgerGuard blocks production browser ledger posting', () => {
    expect(clientGuard).toMatch(/CLIENT_LEDGER_FORBIDDEN/);
    expect(clientGuard).toMatch(/VITE_STRICT_ENV/);
  });

  it('migration does not grant authenticated INSERT on ledger_entries or accounts', () => {
    expect(migration).not.toMatch(/GRANT INSERT ON public\.ledger_entries TO authenticated/i);
    expect(migration).not.toMatch(/GRANT INSERT ON public\.accounts TO authenticated/i);
  });
});

describe('hash chain verification logic', () => {
  it('links entries in order with previous_hash = prior entry_hash', async () => {
    const base = [
      {
        id: '1',
        transactionRef: 'TX-A',
        entryType: 'debit',
        amount: 100,
        balanceBefore: 500,
        balanceAfter: 400,
        accountPhone: '254712345678',
        accountId: 'acc-debit',
        idempotencyKey: 'idem-a',
      },
      {
        id: '2',
        transactionRef: 'TX-A',
        entryType: 'credit',
        amount: 100,
        balanceBefore: 0,
        balanceAfter: 100,
        accountPhone: '254723456789',
        accountId: 'acc-credit',
        idempotencyKey: 'idem-a',
      },
    ];
    const chained = await hashChainRows(base);
    expect(chained[0].previousHash).toBe(GENESIS);
    expect(chained[1].previousHash).toBe(chained[0].entryHash);
    const result = await verifyChainLogic(chained);
    expect(result.ok).toBe(true);
    expect(result.checkedCount).toBe(2);
  });

  it('verify detects tampered entry_hash', async () => {
    const chained = await hashChainRows([
      {
        id: '1',
        transactionRef: 'TX-B',
        entryType: 'debit',
        amount: 50,
        balanceBefore: 200,
        balanceAfter: 150,
        accountPhone: '254700000001',
        accountId: 'a1',
        idempotencyKey: 'k1',
      },
    ]);
    chained[0].entryHash = 'f'.repeat(64);
    const result = await verifyChainLogic(chained);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('entry_hash_mismatch');
    expect(result.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.actualHash).toBe('f'.repeat(64));
  });

  it('duplicate idempotency replay does not extend chain (migration contract)', () => {
    expect(migration).toMatch(/IF v_debit_row\.id IS NULL THEN[\s\S]*claim_ledger_chain_slot/);
    expect(migration).toMatch(/IF v_credit_row\.id IS NULL THEN[\s\S]*claim_ledger_chain_slot/);
  });
});

describe('account resolution contracts', () => {
  it('normalizes Kenyan phone numbers before unique lookup', () => {
    expect(migration).toMatch(/normalize_ledger_external_id/);
    expect(migration).toMatch(/RETURN '254' \|\| substring\(v_clean from 2\)/);
  });

  it('resolve_or_create_account is idempotent via unique index + ON CONFLICT', () => {
    expect(migration).toMatch(/ON CONFLICT \(account_type, external_identifier, currency\)/);
    expect(migration).toMatch(/SELECT id INTO v_account_id[\s\S]*WHERE account_type = v_type/);
  });

  it('system accounts cannot be created by arbitrary external ids', () => {
    expect(migration).toMatch(/v_is_system := v_type IN \('settlement', 'suspense', 'fees'\)/);
    expect(migration).toMatch(/SYSTEM_ACCOUNT_MISSING/);
  });
});

describe('backward compatibility', () => {
  it('preserves account_phone and legacy hash column on insert', () => {
    expect(migration).toMatch(/account_phone, description, hash, owner_id/);
    expect(migration).toMatch(/COALESCE\(p_debit->>'hash', ''\)/);
  });

  it('verify_ledger_chain skips legacy rows without chain_index', () => {
    expect(migration).toMatch(/chain_index IS NOT NULL/);
    expect(migration).toMatch(/skipped_legacy_count/);
  });

  it('payment-lifecycle buildLedgerRpcArgs still uses account_phone (unchanged contract)', async () => {
    const { buildLedgerRpcArgs } = await import('../../supabase/functions/_shared/payment-lifecycle.ts');
    const args = await buildLedgerRpcArgs(
      {
        id: 'p1',
        tx_ref: 'TX-1',
        user_id: 'u1',
        amount: 100,
        from_phone: '254712345678',
        to_phone: '254723456789',
        idempotency_key: 'idem-1',
        status: 'processing',
      },
      500,
      0,
    );
    expect(args.p_debit.account_phone).toBe('254712345678');
    expect(args.p_credit.account_phone).toBe('254723456789');
    expect(args.p_debit.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
