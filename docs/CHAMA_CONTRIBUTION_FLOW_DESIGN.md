# Chama Contribution Flow — Design Document
**Prompt 3.3a · Design only · No code changes**

---

## 0. Reading summary — what the existing code actually does

Before every section below, the key facts extracted from the source files:

| File | Relevant facts |
|---|---|
| `initiate-payment/index.ts` | Reads `body.amount` (client-supplied); validates it 1–150 000 KSh; accepts only `ALLOWED_PAYMENT_TYPES = {send, paybill, airtime, bundle, fuliza_drawdown}` (line 42 of payment-lifecycle.ts). Amount is passed straight to STK push via `Math.ceil(Number(amount))` in `daraja-stk.ts:70`. |
| `_shared/payment-lifecycle.ts` | `buildPendingPaymentRecord` throws `INVALID_PAYMENT_TYPE` if `payment_type` not in the allowed set (line 76). `finalizeDarajaPayment` posts the ledger by calling `postDoubleEntry` then updating `pending_payments`—two separate DB operations, not one transaction (lines 441–449). `buildLedgerRpcArgs` builds leg JSON with only `account_phone`; `resolve_ledger_leg_account` defaults to `account_type='wallet'` when the JSON carries no `account_type` key (ledger migration line 370). |
| `webhook-handler/index.ts` | After full security checks (IP, HMAC, nonce, de-dup), delegates settlement entirely to `finalizeDarajaPayment`. No branching by `payment_type`; no obligation awareness (lines 433–442). |
| `reconciliation-job/index.ts` | Sweeps `status IN ('processing','waiting_for_mpesa')` rows past the timeout cutoff. The sweep moves rows to `timeout` or `review_required` but has **no knowledge of `chama_obligations`**. |
| `_shared/stuck-payments.ts` | Pure function; only touches `pending_payments` rows. Does not reset obligations. |
| `20260610120000_chama_core_schema.sql` | `chama_obligations.amount_due_cents` is `BIGINT` (e.g. 50 000 = KES 500). `pending_payments.amount` is `NUMERIC` shillings. Two indexes are the idempotency backstops: `chama_obligations_settled_receipt_uq` (unique on `settled_receipt WHERE NOT NULL`) and `chama_obligations_payment_tx_ref_uq` (unique on `payment_tx_ref WHERE NOT NULL`). |
| `20260519100000_ledger_accounts_and_hash_chain.sql` | `accounts.account_type` allows `'savings'`—the right type for group treasuries. `chain_scope='global'` is hardcoded in `post_double_entry` (line 404 of the migration). `claim_ledger_chain_slot` auto-creates new scopes on first use, so per-group chains are a zero-schema-change extension. `resolve_or_create_account` is service_role-only and idempotent. |

---

## 1. INITIATION — `chama-contribute` (new Edge Function)

### Recommendation: new Edge Function, not a branch in `initiate-payment`

**Why not a branch in `initiate-payment`:**

1. `initiate-payment` reads `body.amount` before it does anything else (line 145) and rejects any payload where the amount is missing or ≤ 0. A chama contribution must derive its amount server-side from `chama_contribution_cycles.amount_cents`—the client must not supply it. Bolting a pre-check onto the existing function would require reordering validation logic that is tightly coupled to the current linear flow.

2. `ALLOWED_PAYMENT_TYPES` in `payment-lifecycle.ts:42` does not include `'chama_contribution'`. `buildPendingPaymentRecord` throws `INVALID_PAYMENT_TYPE` at line 76 before any domain logic runs. Changing that set affects all existing payment type guards.

3. The provider-directory gate (lines 170–217), the rate-limiter window (lines 228–235), and the risk-engine path (lines 267–380) are all semantically wrong for a group-treasury contribution. The function would accumulate dead-code branches.

4. `initiate-payment` is explicitly a wallet/consumer surface. Chama treasury is a separate bounded context introduced in the pivot (commit `de04da2`).

**A dedicated `chama-contribute` function keeps the two contexts decoupled and each file small and testable.**

### Request contract (client → function)

```
POST /functions/v1/chama-contribute
Authorization: Bearer <jwt>

{
  "obligation_id": "<uuid>",           // the ONLY amount-bearing key
  "from_phone":    "0712345678",       // member's M-PESA phone
  "idempotency_key": "<client-nonce>"  // caller-supplied nonce (same as initiate-payment)
}
```

The client **never sends an amount**. The function derives everything from the obligation.

### Server-side amount derivation

```
obligation  → chama_obligations.amount_due_cents  (BIGINT, e.g. 50000)
amount_kes  = amount_due_cents / 100              (NUMERIC, e.g. 500.00)
```

The division is exact for all legal Kenyan cent amounts (shillings are always whole KES). `amount_kes` is what gets stored in `pending_payments.amount` and sent to `requestDarajaStkPush` (which applies `Math.ceil` per `daraja-stk.ts:70`—a no-op for clean KES amounts).

### Validation sequence (all server-side, service_role)

1. JWT → `supabaseAdmin.auth.getUser(jwt)` → `user_id`.
2. Query with a single JOIN:
   ```sql
   SELECT
     ob.id, ob.status, ob.payment_tx_ref,
     ob.amount_due_cents, ob.group_id,
     cy.status AS cycle_status, cy.amount_cents,
     gr.status AS group_status,
     me.id AS member_id, me.status AS member_status,
     me.user_id
   FROM chama_obligations ob
   JOIN chama_contribution_cycles cy ON cy.id = ob.cycle_id
   JOIN chama_groups gr              ON gr.id = ob.group_id
   JOIN chama_members me             ON me.id = ob.member_id
   WHERE ob.id = :obligation_id
   ```
3. Guard rails (all checked server-side):
   - `me.user_id = auth_user_id` — obligation belongs to this caller
   - `me.status = 'active'` — not suspended/exited
   - `gr.status = 'active'` — group not frozen/closed
   - `cy.status = 'open'` — cycle accepting payments
   - `ob.status = 'due'` — not already in-flight or settled
4. Normalise `from_phone` with `normalizePhone` (reused from `payment-lifecycle.ts:44`); verify it matches `auth.users.phone` (same gate as `initiate-payment` lines 150–163).
5. Rate-limit check: same window query as `initiate-payment` (lines 228–235), scoped to `user_id`.

### Building the `pending_payments` row

```ts
const txRef          = `CC-${obligation_id.slice(0, 8)}-${Date.now()}`;
const idempotencyKey = body.idempotency_key;            // caller-supplied
const amountKes      = Number(obligation.amount_due_cents) / 100;
const toPhone        = `CHAMA:${obligation.group_id}`;  // sentinel, not a real phone
```

`payment_type = 'chama_contribution'` — a **new value** that must be added to the `ALLOWED_PAYMENT_TYPES` set in `payment-lifecycle.ts` when the function is implemented (a one-line additive change to a constant).

`to_phone = 'CHAMA:{group_id}'` serves two roles: it is the `account_phone` for the credit leg in the ledger and it uniquely identifies the group treasury account in `accounts`.

Metadata carries context needed by the settlement RPC:
```json
{
  "obligation_id":      "<uuid>",
  "group_id":           "<uuid>",
  "member_id":          "<uuid>",
  "credit_account_type": "savings"
}
```

### Idempotency on re-submission

Before inserting, check for an existing row with the same `idempotency_key` **and** `user_id` (same pattern as `initiate-payment` lines 238–246). If found, return it. This covers the case where the client retries before receiving a response.

### Writing `payment_tx_ref` onto the obligation

This must happen **after** the `pending_payments` INSERT succeeds but **before** the STK push is fired, using a conditional UPDATE:

```sql
UPDATE chama_obligations
SET    status = 'pending_payment',
       payment_tx_ref = :tx_ref
WHERE  id = :obligation_id
  AND  status = 'due'        -- optimistic concurrency guard
```

If `rowCount = 0` (another request raced and changed the status), delete the just-inserted pending row and return `OBLIGATION_NOT_AVAILABLE 409`. This is the same optimistic-concurrency pattern used elsewhere in the engine.

The `chama_obligations_payment_tx_ref_uq` index (`WHERE payment_tx_ref IS NOT NULL`) is the hard backstop if two requests race past the SELECT check.

### After the STK push

On `stk.ok = true`: update `pending_payments` with `checkout_request_id`, `merchant_request_id`, `status = 'waiting_for_mpesa'` (same as `initiate-payment` lines 406–410).

On `stk.ok = false`: update `pending_payments` to `'failed'`; reset the obligation:
```sql
UPDATE chama_obligations
SET status = 'due', payment_tx_ref = NULL
WHERE id = :obligation_id AND payment_tx_ref = :tx_ref
```

Return the `pending_payment_id` and `tx_ref` to the client.

---

## 2. SETTLEMENT — where the obligation hook lives in `webhook-handler`

### The core problem: two-phase without a transaction

`finalizeDarajaPayment` (payment-lifecycle.ts) executes as sequential async calls — no wrapping DB transaction. The ledger post and the `pending_payments` update are separate round-trips (lines 441–449). Adding obligation settlement as a third sequential step would mean ledger-posted but obligation-not-settled is a possible crash state.

### Recommended: a new `settle_chama_contribution` PostgreSQL RPC

A single `SECURITY DEFINER` PL/pgSQL function that, **in one DB transaction**, does:

1. `SELECT … FOR UPDATE` on `pending_payments WHERE tx_ref = p_tx_ref` (prevents races).
2. `SELECT … FOR UPDATE` on `chama_obligations WHERE payment_tx_ref = p_tx_ref AND status = 'pending_payment'`.
3. Amount verification (server-side, in SQL):
   ```sql
   -- Convert shillings → cents and compare
   IF round(pp.amount * 100) <> ob.amount_due_cents THEN
     RAISE EXCEPTION 'AMOUNT_MISMATCH: pending=% cents, obligation=% cents',
       round(pp.amount * 100), ob.amount_due_cents;
   END IF;
   ```
4. Call `post_double_entry` with correctly typed legs (see §3 below).
5. `UPDATE pending_payments SET status='succeeded', ledger_posted_at=now(), provider_receipt=p_receipt, … WHERE tx_ref = p_tx_ref`.
6. `UPDATE chama_obligations SET status='settled', settled_receipt=p_receipt, settled_at=p_settled_at, ledger_tx_ref=p_tx_ref WHERE id = ob.id`
   — protected by `chama_obligations_settled_receipt_uq ON (settled_receipt) WHERE settled_receipt IS NOT NULL`.

The unique index makes step 6 idempotent: if the receipt was already written by a prior call, the `UPDATE` conflicts → zero rows → the RPC detects this and returns `{duplicate: true}` without re-posting the ledger (step 4 is also idempotent via `post_double_entry`'s own `ON CONFLICT (transaction_ref, entry_type) DO UPDATE` guard).

**RPC signature (to be created in a future migration):**

```sql
settle_chama_contribution(
  p_tx_ref       TEXT,         -- pending_payments.tx_ref
  p_receipt      TEXT,         -- callback.receiptNumber
  p_settled_at   TIMESTAMPTZ,
  p_payload_hash TEXT          -- for pending_payments.callback_payload_hash
) RETURNS JSONB
-- Returns: { ok, duplicate, obligation_id, ledger_tx_ref }
```

### Hook-in point in `webhook-handler`

After the existing security pipeline (IP check → HMAC → nonce → `webhook_events` insert → `findPendingPayment`) and **before** calling `finalizeDarajaPayment`, branch on `payment_type`:

```
pending = await findPendingPayment(...)

if (pending.payment_type === 'chama_contribution') {
  // Chama path: atomic RPC handles ledger + obligation in one TX
  result = await supabaseAdmin.rpc('settle_chama_contribution', {
    p_tx_ref:       pending.tx_ref,
    p_receipt:      callback.receiptNumber,
    p_settled_at:   now(),
    p_payload_hash: payloadHash,
  });
} else {
  // Existing wallet/send/paybill path — unchanged
  result = await finalizeDarajaPayment({ callback, pending, … });
}
```

Non-chama payments never enter the RPC path. The `settle_chama_contribution` RPC returns safely if called with a `tx_ref` that has no linked obligation (non-chama pending that somehow has the flag set) — it skips obligation settlement and just finalises the pending row.

### Amount unit conversion — where it happens

| Location | Unit | Value example |
|---|---|---|
| `chama_contribution_cycles.amount_cents` | BIGINT cents | 50 000 |
| `chama-contribute` function (initiation) | divides by 100 | 500.00 KES |
| `pending_payments.amount` | NUMERIC shillings | 500.00 |
| Daraja STK push request | KES (Math.ceil) | 500 |
| Daraja callback `Amount` field | KES integer | 500 |
| `compareAmount` in finalizeDarajaPayment | both in KES | 500 == 500 ✓ |
| `settle_chama_contribution` RPC (SQL) | converts back: `round(pp.amount * 100)` | 50 000 cents |
| `chama_obligations.amount_due_cents` | BIGINT cents | 50 000 |

The conversion is: **initiation divides by 100 (cents → KES); settlement RPC multiplies by 100 (KES → cents) for the final guard**. No float arithmetic touches money at any stage — `NUMERIC` in Postgres and `Math.round((n + Number.EPSILON) * 100) / 100` in TypeScript (`normalizeMoneyAmount`, payment-lifecycle.ts:53–56).

---

## 3. LEDGER MAPPING

### Account naming for group treasuries

The `accounts` table already has `account_type = 'savings'` in its check constraint (ledger migration line 14). No schema change is needed.

| Leg | account_type | external_identifier | account_phone (ledger_entries) | Notes |
|---|---|---|---|---|
| Debit | `wallet` | normalized member phone, e.g. `254712345678` | `254712345678` | Same as today's wallet send flow |
| Credit | `savings` | `CHAMA:{group_id}` | `CHAMA:{group_id}` | Group treasury; `user_id = NULL`; `display_name = group.name` |

`resolve_or_create_account` (ledger migration lines 137–226) is idempotent: on first contribution to a group it creates the savings account; subsequent contributions find and reuse it. The `idx_accounts_type_external_currency` unique index (`account_type, external_identifier, currency`) is the conflict guard.

### Chain scope

`post_double_entry` hardcodes `v_chain_scope := 'global'` (ledger migration line 404). Both legs of a chama contribution therefore land on the **global chain** — consistent with all existing entries.

Per-group chain scopes (`group:{group_id}`) are an optional future extension: `claim_ledger_chain_slot` auto-creates new chain head rows on first use (`ON CONFLICT DO NOTHING`, ledger migration line 298), so enabling per-group scopes requires only changing the scope argument passed to `post_double_entry`, not a schema migration. This design defers that choice.

### Legs passed to `post_double_entry` (inside the settlement RPC)

```sql
-- Debit leg (member's wallet)
p_debit := jsonb_build_object(
  'transaction_ref',  p_tx_ref,
  'amount',           pp.amount::TEXT,         -- NUMERIC KES, e.g. '500.00'
  'balance_before',   debit_bal_before::TEXT,
  'balance_after',    (debit_bal_before - pp.amount)::TEXT,
  'account_phone',    pp.from_phone,            -- e.g. '254712345678'
  'account_type',     'wallet',
  'owner_id',         pp.user_id::TEXT,
  'description',      'Chama contribution ' || ob.group_id,
  'idempotency_key',  pp.idempotency_key,
  'hash',             ''                        -- legacy field; RPC recomputes entry_hash
);

-- Credit leg (group treasury)
p_credit := jsonb_build_object(
  'transaction_ref',  p_tx_ref,
  'amount',           pp.amount::TEXT,
  'balance_before',   credit_bal_before::TEXT,
  'balance_after',    (credit_bal_before + pp.amount)::TEXT,
  'account_phone',    'CHAMA:' || ob.group_id,  -- sentinel; not a real phone
  'account_type',     'savings',                -- CRITICAL: correct type for group treasury
  'display_name',     gr.name,
  'owner_id',         NULL,                     -- no individual owns the treasury
  'description',      'Chama contribution ' || ob.group_id,
  'idempotency_key',  pp.idempotency_key,
  'hash',             ''
);
```

`resolve_ledger_leg_account` (ledger migration line 344) reads `p_leg->>'account_type'` (line 370) and `p_leg->>'account_phone'` (line 371). Because we supply `account_type = 'savings'` explicitly, the account is resolved correctly without touching the existing path.

### Balance reads for `balance_before`

Inside the settlement RPC, use the same query pattern as `getLatestBalance` in `webhook-handler` (lines 407–415) but scoped to `account_phone`:

```sql
SELECT COALESCE(MAX(balance_after), 0) INTO debit_bal_before
FROM ledger_entries
WHERE account_phone = pp.from_phone
ORDER BY created_at DESC, id DESC
LIMIT 1;

SELECT COALESCE(MAX(balance_after), 0) INTO credit_bal_before
FROM ledger_entries
WHERE account_phone = 'CHAMA:' || ob.group_id::TEXT
ORDER BY created_at DESC, id DESC
LIMIT 1;
```

The `p_expect_debit_balance_before` guard in `post_double_entry` is passed `NULL` for chama contributions (M-PESA has already confirmed the money left the member's phone — we are not modelling a pre-funded internal wallet debit). The function skips the balance-before check when this argument is `NULL` (ledger migration line 428).

---

## 4. FAILURE MODES

### A. Duplicate callback (same receipt, sent twice by Safaricom)

**Detection:** `callbackIdempotencyKey` (payment-lifecycle.ts:148–155) = `mpesa:{checkoutRequestId}:{resultCode}:{receiptNumber}`. The `webhook_events` table has a UNIQUE constraint on `(source, idempotency_key)`. The second callback hits the existing-event check (webhook-handler lines 331–365) before reaching the payment or obligation code.

**Resolution path:**
- Webhook-handler returns `{ok: true, duplicate: true}` (line 364).
- `settle_chama_contribution` RPC is never called for the duplicate.
- Even if it were called (e.g. nonce check bypassed in tests), `chama_obligations_settled_receipt_uq` makes the obligation UPDATE a no-op and `post_double_entry`'s `ON CONFLICT (transaction_ref, entry_type) DO UPDATE` makes the ledger INSERT a no-op. No double-posting is possible.

### B. Lost callback — reconciliation picks up a stuck chama payment

**The gap:** `sweepStuckPendingPayments` (stuck-payments.ts) only touches `pending_payments`; it has no knowledge of `chama_obligations`. When it moves a chama payment to `timeout` or `review_required`, the obligation is left in `pending_payment` status — the member cannot retry.

**Existing machinery covers the timing:**

1. `reconciliation-job` sweeps rows with `status IN ('processing', 'waiting_for_mpesa')` older than `RECONCILIATION_STUCK_AFTER_MINUTES` (default 30 min, reconciliation-job lines 70–71).
2. If `providerQueryConfigured`: it calls the Daraja STK Query API (`queryStkPush`); if Daraja says `succeeded`, the row moves to `review_required` (never auto-settles — no receipt/amount in STK Query response). Ops then manually verifies and triggers `settle_chama_contribution`.
3. If Daraja says `failed/cancelled/timeout`, the pending row moves to that terminal status.

**Additional obligation reset sweep (not yet in the code — must be designed):**

A second pass in `reconciliation-job`, run after `sweepStuckPendingPayments`, queries:

```sql
SELECT ob.id
FROM chama_obligations ob
JOIN pending_payments pp ON pp.tx_ref = ob.payment_tx_ref
WHERE ob.status = 'pending_payment'
  AND pp.status IN ('failed', 'cancelled', 'timeout')
```

For each row: reset `chama_obligations.status = 'due', payment_tx_ref = NULL` so the member can retry. This is idempotent (only acts on rows still in `pending_payment`). The sweep does **not** touch obligations whose pending row is `review_required` — those need ops review.

### C. Amount mismatch

**When it happens:** Daraja returns a different KES amount than what was sent in the STK push. Extremely rare (never seen in practice for standard STK Push); more likely in sandbox testing.

**Resolution path:**

For the non-chama path, `finalizeDarajaPayment` handles it at lines 410–435: sets `pending_payments.status = 'review_required'`, writes a `payment_reconciliation_events` row, no ledger post.

For the chama path, `settle_chama_contribution` RPC:
- Its internal amount verification (`compareAmount` equivalent: `ABS(callback.amount - pp.amount) > 0.01`) fails.
- The RPC raises an exception or returns `{ok: false, error: 'AMOUNT_MISMATCH'}`.
- Webhook-handler catches this, sets `pending_payments.status = 'review_required'`, writes reconciliation event.
- Obligation remains in `pending_payment` status.
- Obligation reset sweep (§4-B) does **not** reset review_required pending rows; ops resolves manually.

### D. Callback for a `tx_ref` with no linked obligation (plain wallet-era payment)

**Why this is safe:**

`findPendingPayment` (webhook-handler lines 146–163) finds the pending row by `checkout_request_id`. The webhook-handler then checks `pending.payment_type`. If `payment_type ≠ 'chama_contribution'`, the **existing `finalizeDarajaPayment` path runs unchanged**. The chama settlement RPC is never called.

If somehow `settle_chama_contribution` were called with a non-chama `tx_ref`: it queries `chama_obligations WHERE payment_tx_ref = p_tx_ref` and finds zero rows. It skips the obligation block and only finalises `pending_payments` (or returns `{obligation_settled: false}` gracefully). It never errors on a missing obligation.

### E. Failed / cancelled STK push (member declines or Daraja rejects)

**Callback path (ResultCode ≠ 0):**

`callbackStatus` (payment-lifecycle.ts:136–141) returns `'cancelled'` (code 1032) or `'failed'`. In the chama path, `settle_chama_contribution` RPC detects `status ≠ 'succeeded'` (or receives a `p_receipt = NULL` guard) and:
- Updates `pending_payments` to the terminal failure status.
- Does **not** touch the obligation (no receipt to write).
- Returns `{ok: true, ledgerPosted: false}`.

The obligation reset sweep (§4-B) then finds this obligation (`pending_payments.status = 'failed'/'cancelled'`) and resets it to `due` — member can retry.

**No callback received (STK Push sent but callback never arrives):**

Handled by reconciliation sweep in §4-B.

**STK Push rejected at initiation (`stk.ok = false`):**

Caught in `chama-contribute` before any obligation status change propagates (the obligation UPDATE to `pending_payment` is rolled back explicitly when STK push fails — see §1 last paragraph).

---

## 5. STATE MACHINE

### Full obligation status transition table

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│  FROM status    │  TO status       │  Actor                     │  Trigger / Condition        │
├─────────────────┼──────────────────┼────────────────────────────┼─────────────────────────────┤
│  (created)      │  due             │  chama-contribute (open     │  Cycle opened; obligations  │
│                 │                  │  cycle migration or future  │  created by a future        │
│                 │                  │  chama-open-cycle fn)       │  chama-open-cycle function  │
├─────────────────┼──────────────────┼────────────────────────────┼─────────────────────────────┤
│  due            │  pending_payment │  chama-contribute           │  JWT validated; member      │
│                 │                  │                             │  active; cycle open; STK    │
│                 │                  │                             │  push accepted by Daraja    │
│                 │                  │                             │  (stk.ok = true); tx_ref    │
│                 │                  │                             │  written to obligation      │
├─────────────────┼──────────────────┼────────────────────────────┼─────────────────────────────┤
│  pending_payment│  settled         │  webhook-handler via        │  Daraja callback            │
│                 │                  │  settle_chama_contribution  │  ResultCode = '0'; amount   │
│                 │                  │  RPC                        │  & phone verified; ledger   │
│                 │                  │                             │  pair posted;               │
│                 │                  │                             │  settled_receipt written    │
├─────────────────┼──────────────────┼────────────────────────────┼─────────────────────────────┤
│  pending_payment│  due             │  reconciliation-job         │  Obligation reset sweep:    │
│                 │                  │  (obligation reset sweep,   │  linked pending_payment     │
│                 │                  │  §4-B)                      │  status ∈ {failed,          │
│                 │                  │                             │  cancelled, timeout}        │
├─────────────────┼──────────────────┼────────────────────────────┼─────────────────────────────┤
│  pending_payment│  pending_payment │  chama-contribute           │  Member retries while       │
│                 │  (no-op)         │  (idempotency check)        │  obligation already         │
│                 │                  │                             │  in-flight: idempotency_key │
│                 │                  │                             │  = 'chama_contrib_{ob.id}'  │
│                 │                  │                             │  hits existing pending row; │
│                 │                  │                             │  returns existing tx_ref    │
├─────────────────┼──────────────────┼────────────────────────────┼─────────────────────────────┤
│  due            │  waived          │  future chama-admin fn      │  Treasurer/chair manual     │
│                 │                  │  (service_role)             │  waiver (out of scope here) │
├─────────────────┼──────────────────┼────────────────────────────┼─────────────────────────────┤
│  settled        │  (terminal)      │  —                          │  No transitions out         │
│  waived         │  (terminal)      │  —                          │  No transitions out         │
└─────────────────┴──────────────────┴────────────────────────────┴─────────────────────────────┘
```

### Retry-while-pending detail

`idempotency_key = 'chama_contrib_{obligation_id}'` (one stable key per obligation). `chama-contribute` checks for an existing `pending_payments` row with this key and the caller's `user_id` (same pattern as `initiate-payment` lines 238–246). If found, it returns the existing `pending_payment_id` and `tx_ref` with `duplicate: true`. No new STK push is fired; the obligation status does not change. This is the correct behaviour — the member's phone is already showing the M-PESA PIN prompt (or the first push expired, in which case reconciliation will reset).

---

## 6. TEST PLAN

### Files to add (none of these exist today)

#### `supabase/functions/chama-contribute/index.test.ts`

| Test case | What it asserts |
|---|---|
| **Happy path** | Valid JWT + obligation in `due` state → `pending_payments` row inserted with `payment_type='chama_contribution'`, `amount=cycles.amount_cents/100`, obligation status becomes `pending_payment`, `payment_tx_ref` written. STK push mock returns success. Response contains `pending_payment_id` and `tx_ref`. |
| **Amount is not client-supplied** | Request with `amount` field in body → field is ignored; stored amount matches cycle, not body. |
| **Non-member rejection** | JWT for user_id not in `chama_members` for this group → 403 OBLIGATION_NOT_FOUND. |
| **Suspended member** | `chama_members.status = 'suspended'` → 403. |
| **Closed cycle** | `chama_contribution_cycles.status = 'closed'` → 409. |
| **Obligation already pending_payment** | obligation.status = 'pending_payment' → idempotency check returns existing pending row with `duplicate: true`, no new STK push. |
| **Obligation already settled** | obligation.status = 'settled' → 409 OBLIGATION_NOT_AVAILABLE. |
| **STK push rejected** | Daraja mock returns `ResponseCode ≠ '0'` → obligation reset to `due`, `payment_tx_ref = NULL`, response 422. |
| **Race condition (optimistic concurrency)** | Two concurrent requests for same obligation → first succeeds, second gets 0-row UPDATE → 409 OBLIGATION_NOT_AVAILABLE. |

#### `supabase/functions/_shared/chama-obligation-settler.test.ts`

Unit tests for the `settle_chama_contribution` RPC contract, exercised through a Supabase test client:

| Test case | What it asserts |
|---|---|
| **Happy path — first receipt** | RPC with valid tx_ref, matching receipt → obligation status = `settled`, `settled_receipt` = receipt, `ledger_tx_ref` = tx_ref; pending_payment status = `succeeded`, `ledger_posted_at IS NOT NULL`; two `ledger_entries` rows with correct debit (wallet) and credit (savings) account types. |
| **Duplicate callback — same receipt twice** | Call RPC twice with same `p_receipt` → second call hits `chama_obligations_settled_receipt_uq`; returns `{duplicate: true}`; ledger_entries count unchanged (still 2 rows); no extra obligation update. |
| **Amount mismatch** | Insert pending_payment with `amount=500`, obligation with `amount_due_cents=60000` → RPC raises `AMOUNT_MISMATCH`; no ledger entries; obligation still `pending_payment`. |
| **Non-chama tx_ref passthrough** | Call RPC with tx_ref from a `payment_type='send'` pending_payment → RPC finds no obligation, returns `{obligation_settled: false, ok: true}`; pending_payment is finalised normally. |
| **Obligation already settled (idempotent ledger replay)** | `post_double_entry` is idempotent ON CONFLICT; second call with same tx_ref returns existing debit/credit row ids; obligation stays `settled`. |

#### `supabase/functions/webhook-handler/chama-settlement.test.ts`

Integration tests through the full webhook-handler endpoint:

| Test case | What it asserts |
|---|---|
| **Happy path** | POST with valid Daraja callback for a `chama_contribution` pending payment → webhook-handler routes to `settle_chama_contribution` RPC; response `{ok:true, status:'succeeded', ledgerPosted:true}`; obligation settled; ledger entries present. |
| **Duplicate callback (same idempotency key)** | Second POST with identical payload → `webhook_events` de-dup fires (existing event found); reconciliation event written with `event_type='duplicate_callback'`; obligation not double-settled; ledger entry count unchanged. |
| **Lost callback via reconciliation** | Insert a `chama_contribution` pending_payment aged 40 min (past `RECONCILIATION_STUCK_AFTER_MINUTES=30`); POST to `reconciliation-job` → `sweepStuckPendingPayments` marks it `timeout`; obligation reset sweep sets obligation back to `due`. |
| **Amount mismatch rejection** | Callback returns `Amount=600` for a pending_payment where `amount=500.00` → webhook-handler catches RPC error; pending_payment → `review_required`; obligation stays `pending_payment`; reconciliation event written. |
| **Wallet payment without obligation passthrough** | `payment_type='send'` pending payment receives callback → webhook-handler calls existing `finalizeDarajaPayment` path; `settle_chama_contribution` RPC not called; no error; ledger posted normally. |
| **Retry-while-pending (member submits twice)** | Two `chama-contribute` requests with same `idempotency_key` → second returns `{duplicate:true}` with existing `pending_payment_id`; only one pending_payment row exists; obligation still `pending_payment` (not double-stamped). |

#### Adjustment to `supabase/functions/reconciliation-job/index.test.ts`

Add test for the **obligation reset sweep** (§4-B):
- Seed: obligation in `pending_payment`, linked pending_payment in `failed`.
- POST reconciliation-job → obligation reset to `due`, `payment_tx_ref = NULL`.
- Verify obligation is payable again (second `chama-contribute` request succeeds).

---

## 7. WHAT YOU WILL NOT TOUCH

The following files and database objects are **read-only** for this feature. They must not be modified, extended, or have new imports added:

| Artifact | Reason to leave untouched |
|---|---|
| `supabase/functions/initiate-payment/index.ts` | Wallet/consumer payment surface. Chama contributions are a separate bounded context. |
| `supabase/functions/_shared/payment-lifecycle.ts` | **One additive exception only**: add `'chama_contribution'` to `ALLOWED_PAYMENT_TYPES` set (line 42). No other changes. `finalizeDarajaPayment`, `buildLedgerRpcArgs`, `buildPendingPaymentRecord` are untouched in their logic. |
| `supabase/functions/_shared/daraja-stk.ts` | Reused as-is by `chama-contribute` via import. No changes. |
| `supabase/functions/_shared/stuck-payments.ts` | Pure function; chama obligation reset is a separate higher-level sweep in `reconciliation-job`, not a change to this module. |
| `supabase/functions/webhook-handler/index.ts` | **One additive change only**: a `payment_type` branch that routes chama payments to the new RPC instead of `finalizeDarajaPayment`. All security checks (IP, HMAC, nonce, de-dup) are shared and unchanged. |
| `supabase/functions/reconciliation-job/index.ts` | **One additive change only**: call the obligation reset sweep after the existing `sweepStuckPendingPayments` call. No changes to existing sweep logic or provider-query flow. |
| `supabase/migrations/20260610120000_chama_core_schema.sql` | Already applied; do not modify. The `settle_chama_contribution` RPC and obligation reset sweep live in a new migration (`20260611*_settle_chama_contribution.sql`). |
| `supabase/migrations/20260519100000_ledger_accounts_and_hash_chain.sql` | Already applied; `post_double_entry`, `resolve_or_create_account`, chain heads — all used as-is. No modifications. |
| All existing RLS policies on `pending_payments`, `ledger_entries`, `accounts`, `webhook_events`, `audit_events` | Service_role already bypasses RLS (BYPASSRLS). No policy changes needed. |
| All existing wallet, send_money, paybill, airtime, bundle, fuliza flows | The `payment_type` gate in webhook-handler ensures zero code-path overlap. |
| `src/` directory | Per project rules: all money logic lives in `supabase/functions/`. |

---

*End of design document. No code, migrations, or functions have been created or modified.*
