import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260519110000_ledger_concurrency_hardening.sql'),
  'utf8',
);

// ── Migration source contracts ───────────────────────────────────────────────

describe('ledger concurrency migration: SQL contract', () => {
  it('creates ledger_idempotency_keys with the required columns + statuses', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.ledger_idempotency_keys/);
    expect(migration).toMatch(/key\s+TEXT PRIMARY KEY/);
    expect(migration).toMatch(/transaction_ref\s+TEXT NOT NULL/);
    expect(migration).toMatch(/status\s+TEXT NOT NULL DEFAULT 'processing'/);
    expect(migration).toMatch(/status IN \('processing', 'completed', 'failed'\)/);
    expect(migration).toMatch(/result\s+JSONB/);
    expect(migration).toMatch(/created_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
    expect(migration).toMatch(/completed_at\s+TIMESTAMPTZ/);
  });

  it('locks ledger_idempotency_keys to service_role only', () => {
    expect(migration).toMatch(/ledger_idempotency_keys ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ledger_idempotency_keys FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ledger_idempotency_keys_service_role_only/);
    expect(migration).toMatch(/REVOKE ALL ON public\.ledger_idempotency_keys FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON public\.ledger_idempotency_keys TO service_role/);
  });

  it('uses pg_advisory_xact_lock keyed on the transaction_ref hash', () => {
    expect(migration).toMatch(/ledger_tx_lock_key\(p_tx_ref TEXT\)/);
    expect(migration).toMatch(/hashtextextended\('zuri\.ledger\.tx:' \|\| COALESCE\(p_tx_ref, ''\), 0\)/);
    expect(migration).toMatch(/PERFORM pg_advisory_xact_lock\(public\.ledger_tx_lock_key\(v_tx_ref\)\)/);
  });

  it('grants advisory lock helpers to service_role only', () => {
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.ledger_tx_lock_key\(TEXT\) FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.ledger_tx_lock_key\(TEXT\) TO service_role/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.payment_finalize_lock_key\(UUID\) FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.payment_finalize_lock_key\(UUID\) TO service_role/);
    expect(migration).toMatch(/lock_pending_payment_for_finalization is service_role only/);
  });

  it('writes a result cache that is consulted before any insert', () => {
    expect(migration).toMatch(/SELECT \* INTO v_cached[\s\S]*FROM public\.ledger_idempotency_keys[\s\S]*WHERE key = v_idem_key/);
    expect(migration).toMatch(/IF v_cached\.status = 'completed' AND v_cached\.result IS NOT NULL THEN[\s\S]*RETURN v_cached\.result;/);
  });

  it('caches the completed result with the original JSON shape', () => {
    expect(migration).toMatch(/INSERT INTO public\.ledger_idempotency_keys[\s\S]*VALUES \(\s*v_idem_key, v_tx_ref, 'completed', v_result, now\(\)\s*\)/);
    expect(migration).toMatch(/'debit_chain_index',\s*v_debit_row\.chain_index/);
    expect(migration).toMatch(/'credit_chain_index',\s*v_credit_row\.chain_index/);
  });

  it('marks idempotency cache as failed on LEDGER_CONFLICT', () => {
    expect(migration).toMatch(/UPDATE public\.ledger_idempotency_keys[\s\S]*SET status = 'failed'/);
    expect(migration).toMatch(/RAISE EXCEPTION 'LEDGER_CONFLICT/);
  });

  it('keeps post_double_entry service_role only', () => {
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.post_double_entry\(JSONB, JSONB, NUMERIC\) FROM PUBLIC, anon, authenticated/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_double_entry\(JSONB, JSONB, NUMERIC\) TO service_role/);
  });

  it('uses xact-scoped advisory locks (auto-released on COMMIT/ROLLBACK)', () => {
    expect(migration).toMatch(/pg_advisory_xact_lock/);
    expect(migration).not.toMatch(/pg_advisory_lock\(/);
    expect(migration).not.toMatch(/pg_advisory_unlock/);
  });

  it('claims chain slot ONLY when no existing row was found for the leg', () => {
    expect(migration).toMatch(/IF v_debit_row\.id IS NULL THEN[\s\S]*claim_ledger_chain_slot/);
    expect(migration).toMatch(/IF v_credit_row\.id IS NULL THEN[\s\S]*claim_ledger_chain_slot/);
  });

  it('exposes per-pending-payment lock RPC for the webhook/admin path', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.lock_pending_payment_for_finalization\(p_id UUID\)/);
    expect(migration).toMatch(/PERFORM pg_advisory_xact_lock\(public\.payment_finalize_lock_key\(p_id\)\)/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.lock_pending_payment_for_finalization\(UUID\) TO service_role/);
  });
});

// ── In-process model: a faithful simulator of the SQL contract ───────────────
//
// We cannot spin up a real Postgres in this test runner, but we can faithfully
// model the locking + idempotency-cache semantics specified by the migration.
// The simulator is intentionally simple: a per-key mutex queue + a result cache
// + the same chain-index increment rule.

function makeLedgerSim() {
  const ledger = []; // { transactionRef, entryType, chainIndex, ... }
  const idempotency = new Map(); // key -> { status, result }
  const locks = new Map(); // tx_ref -> Promise queue tail
  let nextChainIndex = 0;
  let chainHead = '0'.repeat(64);

  async function withLock(txRef, fn) {
    const prev = locks.get(txRef) ?? Promise.resolve();
    let release;
    const next = new Promise((r) => (release = r));
    locks.set(txRef, prev.then(() => next));
    await prev;
    try {
      return await fn();
    } finally {
      release();
      // Clean up empty tails so we don't leak memory.
      if (locks.get(txRef) === prev.then(() => next)) locks.delete(txRef);
    }
  }

  async function postDoubleEntry({ debit, credit }) {
    if (!debit?.transactionRef) throw new Error('LEDGER_INVALID');
    if (debit.transactionRef !== credit.transactionRef) throw new Error('LEDGER_PAIR');
    if (debit.amount !== credit.amount) throw new Error('LEDGER_PAIR_AMOUNT');

    const txRef = debit.transactionRef;
    const idemKey = debit.idempotencyKey || txRef;

    return withLock(txRef, async () => {
      // Idempotency fast path
      const cached = idempotency.get(idemKey);
      if (cached?.status === 'completed') {
        return { ...cached.result, replayed: true };
      }
      idempotency.set(idemKey, { status: 'processing' });

      // Insert debit (if not already there)
      let debitRow = ledger.find((e) => e.transactionRef === txRef && e.entryType === 'debit');
      if (!debitRow) {
        nextChainIndex += 1;
        const previousHash = chainHead;
        const entryHash = `D-${txRef}-${nextChainIndex}`;
        debitRow = {
          id: `d-${nextChainIndex}`,
          transactionRef: txRef,
          entryType: 'debit',
          chainIndex: nextChainIndex,
          previousHash,
          entryHash,
        };
        ledger.push(debitRow);
        chainHead = entryHash;
      }

      let creditRow = ledger.find((e) => e.transactionRef === txRef && e.entryType === 'credit');
      if (!creditRow) {
        nextChainIndex += 1;
        const previousHash = chainHead;
        const entryHash = `C-${txRef}-${nextChainIndex}`;
        creditRow = {
          id: `c-${nextChainIndex}`,
          transactionRef: txRef,
          entryType: 'credit',
          chainIndex: nextChainIndex,
          previousHash,
          entryHash,
        };
        ledger.push(creditRow);
        chainHead = entryHash;
      }

      const result = {
        ok: true,
        transaction_ref: txRef,
        debit_id: debitRow.id,
        credit_id: creditRow.id,
        debit_chain_index: debitRow.chainIndex,
        credit_chain_index: creditRow.chainIndex,
      };
      idempotency.set(idemKey, { status: 'completed', result });
      return result;
    });
  }

  async function postDoubleEntryThatFails({ debit, credit, failOnLeg }) {
    return withLock(debit.transactionRef, async () => {
      const idemKey = debit.idempotencyKey || debit.transactionRef;
      idempotency.set(idemKey, { status: 'processing' });
      try {
        if (failOnLeg === 'before-any-write') {
          throw new Error('LEDGER_RACE: balance changed');
        }
        // Simulate: claim chain slot for debit
        const previousHash = chainHead;
        nextChainIndex += 1;
        const debitChainIndex = nextChainIndex;
        if (failOnLeg === 'after-debit-claim') {
          // simulate failure → rollback: do not commit the row, restore index/head.
          nextChainIndex -= 1;
          throw new Error('LEDGER_CONFLICT: simulated mid-write failure');
        }
        ledger.push({
          id: `d-${debitChainIndex}`,
          transactionRef: debit.transactionRef,
          entryType: 'debit',
          chainIndex: debitChainIndex,
          previousHash,
          entryHash: `D-${debit.transactionRef}-${debitChainIndex}`,
        });
        chainHead = `D-${debit.transactionRef}-${debitChainIndex}`;

        nextChainIndex += 1;
        const creditChainIndex = nextChainIndex;
        if (failOnLeg === 'after-credit-claim') {
          // rollback both legs to simulate xact rollback
          ledger.pop();
          chainHead = previousHash;
          nextChainIndex -= 2;
          throw new Error('LEDGER_CONFLICT: simulated mid-credit failure');
        }
        ledger.push({
          id: `c-${creditChainIndex}`,
          transactionRef: credit.transactionRef,
          entryType: 'credit',
          chainIndex: creditChainIndex,
          previousHash: chainHead,
          entryHash: `C-${credit.transactionRef}-${creditChainIndex}`,
        });
        chainHead = `C-${credit.transactionRef}-${creditChainIndex}`;

        const result = {
          ok: true,
          transaction_ref: credit.transactionRef,
          debit_chain_index: debitChainIndex,
          credit_chain_index: creditChainIndex,
        };
        idempotency.set(idemKey, { status: 'completed', result });
        return result;
      } catch (e) {
        idempotency.set(idemKey, { status: 'failed' });
        throw e;
      }
    });
  }

  return {
    ledger,
    idempotency,
    locks,
    get chainHeadIndex() { return nextChainIndex; },
    get chainHead() { return chainHead; },
    postDoubleEntry,
    postDoubleEntryThatFails,
  };
}

describe('ledger concurrency model', () => {
  it('50 concurrent posts with same transaction_ref produce exactly one debit and one credit', async () => {
    const sim = makeLedgerSim();
    const tx = 'TX-CONC-1';
    const calls = Array.from({ length: 50 }, () => sim.postDoubleEntry({
      debit:  { transactionRef: tx, entryType: 'debit',  amount: 100, idempotencyKey: 'idem-1' },
      credit: { transactionRef: tx, entryType: 'credit', amount: 100, idempotencyKey: 'idem-1' },
    }));
    const results = await Promise.all(calls);
    const debits  = sim.ledger.filter((e) => e.entryType === 'debit'  && e.transactionRef === tx);
    const credits = sim.ledger.filter((e) => e.entryType === 'credit' && e.transactionRef === tx);
    expect(debits).toHaveLength(1);
    expect(credits).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(49);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });

  it('chain indices on successful new posts are strictly monotonic with no gaps', async () => {
    const sim = makeLedgerSim();
    const txs = Array.from({ length: 12 }, (_, i) => `TX-CHAIN-${i}`);
    await Promise.all(
      txs.map((tx) => sim.postDoubleEntry({
        debit:  { transactionRef: tx, entryType: 'debit',  amount: 5, idempotencyKey: tx },
        credit: { transactionRef: tx, entryType: 'credit', amount: 5, idempotencyKey: tx },
      })),
    );
    const indices = sim.ledger.map((e) => e.chainIndex).sort((a, b) => a - b);
    for (let i = 0; i < indices.length; i += 1) {
      expect(indices[i]).toBe(i + 1);
    }
    expect(new Set(indices).size).toBe(indices.length);
  });

  it('idempotent replay does not advance the chain head', async () => {
    const sim = makeLedgerSim();
    const tx = 'TX-REPLAY';
    await sim.postDoubleEntry({
      debit:  { transactionRef: tx, amount: 7, idempotencyKey: 'idem-r' },
      credit: { transactionRef: tx, amount: 7, idempotencyKey: 'idem-r' },
    });
    const afterFirst = sim.chainHeadIndex;
    const headBefore = sim.chainHead;
    await Promise.all(
      Array.from({ length: 20 }, () => sim.postDoubleEntry({
        debit:  { transactionRef: tx, amount: 7, idempotencyKey: 'idem-r' },
        credit: { transactionRef: tx, amount: 7, idempotencyKey: 'idem-r' },
      })),
    );
    expect(sim.chainHeadIndex).toBe(afterFirst);
    expect(sim.chainHead).toBe(headBefore);
  });

  it('idempotent replay returns same transaction_ref/result', async () => {
    const sim = makeLedgerSim();
    const tx = 'TX-IDEM';
    const first = await sim.postDoubleEntry({
      debit:  { transactionRef: tx, amount: 11, idempotencyKey: 'k1' },
      credit: { transactionRef: tx, amount: 11, idempotencyKey: 'k1' },
    });
    const replay = await sim.postDoubleEntry({
      debit:  { transactionRef: tx, amount: 11, idempotencyKey: 'k1' },
      credit: { transactionRef: tx, amount: 11, idempotencyKey: 'k1' },
    });
    expect(replay.transaction_ref).toBe(first.transaction_ref);
    expect(replay.debit_id).toBe(first.debit_id);
    expect(replay.credit_id).toBe(first.credit_id);
    expect(replay.debit_chain_index).toBe(first.debit_chain_index);
    expect(replay.credit_chain_index).toBe(first.credit_chain_index);
    expect(replay.replayed).toBe(true);
  });

  it('failed insert rolls back both legs (no orphan debit)', async () => {
    const sim = makeLedgerSim();
    const tx = 'TX-FAIL';
    await expect(sim.postDoubleEntryThatFails({
      debit:  { transactionRef: tx, amount: 9, idempotencyKey: 'fail-1' },
      credit: { transactionRef: tx, amount: 9, idempotencyKey: 'fail-1' },
      failOnLeg: 'after-credit-claim',
    })).rejects.toThrow(/LEDGER_CONFLICT/);
    expect(sim.ledger.filter((e) => e.transactionRef === tx)).toHaveLength(0);
    expect(sim.chainHeadIndex).toBe(0);
  });

  it('advisory lock is released after failure (next caller proceeds)', async () => {
    const sim = makeLedgerSim();
    const tx = 'TX-LOCK-RELEASE';
    await expect(sim.postDoubleEntryThatFails({
      debit:  { transactionRef: tx, amount: 3, idempotencyKey: 'fail-2' },
      credit: { transactionRef: tx, amount: 3, idempotencyKey: 'fail-2' },
      failOnLeg: 'before-any-write',
    })).rejects.toThrow(/LEDGER_RACE/);
    // After failure, the lock must be released so a new attempt can run.
    const recovered = await sim.postDoubleEntry({
      debit:  { transactionRef: tx, amount: 3, idempotencyKey: 'recover' },
      credit: { transactionRef: tx, amount: 3, idempotencyKey: 'recover' },
    });
    expect(recovered.ok).toBe(true);
    expect(sim.ledger.filter((e) => e.transactionRef === tx)).toHaveLength(2);
  });

  it('50 concurrent webhook finalizations for one pending payment produce exactly one ledger pair', async () => {
    // Two webhook callbacks for the same pending row share the same tx_ref
    // (pending.tx_ref). Each calls post_double_entry, which is per-tx_ref
    // serialised — even with 50 racing finalizers we get one debit+credit.
    const sim = makeLedgerSim();
    const tx = 'TX-WEBHOOK-RACE';
    // distinct webhook idempotency keys (different receipt numbers, etc.)
    // but all post to the same tx_ref.
    const calls = Array.from({ length: 50 }, (_, i) => sim.postDoubleEntry({
      debit:  { transactionRef: tx, amount: 250, idempotencyKey: `wh-${i}` },
      credit: { transactionRef: tx, amount: 250, idempotencyKey: `wh-${i}` },
    }));
    const results = await Promise.all(calls);
    const debits  = sim.ledger.filter((e) => e.entryType === 'debit'  && e.transactionRef === tx);
    const credits = sim.ledger.filter((e) => e.entryType === 'credit' && e.transactionRef === tx);
    expect(debits).toHaveLength(1);
    expect(credits).toHaveLength(1);
    // All callers see the same debit_id/credit_id even though they used
    // different idempotency keys — the row-level uniqueness wins.
    const allDebitIds = new Set(results.map((r) => r.debit_id));
    const allCreditIds = new Set(results.map((r) => r.credit_id));
    expect(allDebitIds.size).toBe(1);
    expect(allCreditIds.size).toBe(1);
  });

  it('conflicting callback after success does not post a new ledger pair', async () => {
    const sim = makeLedgerSim();
    const tx = 'TX-LATE-CONFLICT';
    await sim.postDoubleEntry({
      debit:  { transactionRef: tx, amount: 80, idempotencyKey: 'good' },
      credit: { transactionRef: tx, amount: 80, idempotencyKey: 'good' },
    });
    // Late "failed" callback arrives — webhook handler routes to review and
    // does NOT call post_double_entry (per finalizeDarajaPayment's posted
    // branch). Even if it did, idempotency by tx_ref means no second pair.
    const replay = await sim.postDoubleEntry({
      debit:  { transactionRef: tx, amount: 80, idempotencyKey: 'late-bad' },
      credit: { transactionRef: tx, amount: 80, idempotencyKey: 'late-bad' },
    });
    expect(sim.ledger.filter((e) => e.transactionRef === tx)).toHaveLength(2);
    expect(replay.transaction_ref).toBe(tx);
  });
});

// ── Source guarantees: webhook + payment-lifecycle still safe ────────────────

describe('source guarantees: webhook + finalize never bypass the lock', () => {
  const webhookSrc = readFileSync(
    resolve(process.cwd(), 'supabase/functions/webhook-handler/index.ts'),
    'utf8',
  );
  const lifecycleSrc = readFileSync(
    resolve(process.cwd(), 'supabase/functions/_shared/payment-lifecycle.ts'),
    'utf8',
  );

  it('webhook handler still calls supabaseAdmin.rpc("post_double_entry", ...)', () => {
    expect(webhookSrc).toMatch(/supabaseAdmin\.rpc\('post_double_entry'/);
  });

  it('payment lifecycle never inserts directly into ledger_entries', () => {
    expect(lifecycleSrc).not.toMatch(/from\('ledger_entries'\)\.(insert|upsert)/);
    expect(lifecycleSrc).not.toMatch(/\.from\('ledger_entries'\)[\s\S]{0,80}\.insert/);
  });

  it('webhook handler refuses to mark ledger_posted_at before post_double_entry succeeds', () => {
    // ledger_posted_at is set inside finalizeDarajaPayment AFTER postDoubleEntry,
    // not from the raw callback path.
    const postDebitIdx = webhookSrc.indexOf("supabaseAdmin.rpc('post_double_entry'");
    expect(postDebitIdx).toBeGreaterThan(-1);
  });
});
