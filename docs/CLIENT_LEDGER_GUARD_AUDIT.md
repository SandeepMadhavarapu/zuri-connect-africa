# Client Ledger Guard — Audit Report

## Date and prompt
2025-11-05, Prompt 2.4

## Question audited
Can any client-side code path post to the local ledger without triggering clientLedgerGuard?

## Method
Grepped `src/` for all three exported guard symbols (`assertClientLedgerPostingAllowed`,
`isClientDemoLedgerAllowed`, `clientLedgerForbiddenResult`). Read each callsite file in full
to trace the execution path before and after the guard. Grepped `src/` for
`localStorage.setItem` with both `zuri_` key prefix and `ledger` key variants.
Read `src/lib/localLedgerStore.js` in full; traced every caller of `appendLocalLedgerEntry`.

---

## Callsites table

| File:line | Caller function | What the caller does | Guard at TOP? | Could code post to local ledger without first hitting this guard? | Notes |
|---|---|---|---|---|---|
| [src/api/ledger.js:17](../src/api/ledger.js) | `postTransaction` (api layer) | Wraps `LedgerLib.postTransaction`; adds trace, metrics, and event emission for the local-demo ledger path | **No** — `obs.startTrace(...)` runs at L15 before the guard at L17. `obs.startTrace` is telemetry only; no ledger write. | No | Guard throws before `LedgerLib.postTransaction` is reached. Telemetry-before-guard is cosmetically inconsistent but carries no ledger-write risk. |
| [src/services/paymentService.js:65](../src/services/paymentService.js) | `initiateServerPayment` | Routes payment to demo path (`lib/ledger.postTransaction`) or real STK Push Edge Function depending on guard result | **No** — three pure-computation lines run first (L61–63: `normalizedAmount`, `transactionRef`, idempotency key). No I/O or storage side-effects. Guard is at L65. | No | Guard used as a routing branch (if-allowed → demo; else → real Edge Function). Production always takes the else branch; the demo path itself calls `lib/ledger.postTransaction` which re-checks the guard at the top. |
| [src/services/ledgerService.js:94](../src/services/ledgerService.js) | `createLedgerEntry` | Inserts a single row into Supabase `ledger_entries` table | **Yes** — `assertClientLedgerPostingAllowed()` is the first statement | No | Hard gate; throws immediately in non-demo environments. |
| [src/services/ledgerService.js:120](../src/services/ledgerService.js) | `persistEntry` | Idempotent upsert into `ledger_entries`; wraps result in a forbidden object rather than throwing | **Yes** — first statement inside `try` block; returns `clientLedgerForbiddenResult()` before any DB access | No | Soft gate (returns, does not throw). No DB upsert occurs in production. |
| [src/lib/ledgerRpc.js:26](../src/lib/ledgerRpc.js) | `postDoubleEntryAtomic` | Calls Postgres `post_double_entry` RPC atomically for both ledger legs | **Yes** — `assertClientLedgerPostingAllowed()` is the first statement | No | Hard gate. This is also the *implicit* guard for `reverseTransaction`, which does not have its own top-level guard (see F1 below). |
| [src/lib/ledger.js:287](../src/lib/ledger.js) | `postTransaction` (ledger engine) | Full double-entry post: reads balances, validates pair, calls `postDoubleEntryAtomic`, then mirrors to local store | **Yes** — `assertClientLedgerPostingAllowed()` is the first statement | No | `appendLocalLedgerEntry` calls at L447/454 only execute after the guard has already passed and `postDoubleEntryAtomic` has succeeded. |

**Total active callsites found: 6** (across 4 source files)

---

## Findings

- **F1: `reverseTransaction` lacks a guard at function entry — MEDIUM**
  `src/lib/ledger.js:489` — `reverseTransaction` does not call `assertClientLedgerPostingAllowed()` at its
  start. Before any write, it reads originals, computes reversal payloads, and computes hashes (all
  read-only or pure). The guard fires inside `postDoubleEntryAtomic` at L568. Because
  `postDoubleEntryAtomic` throws in non-demo environments, the `appendLocalLedgerEntry` calls at L578/584
  (in the `try` block that follows) are unreachable in production. There is no active ledger-write bypass,
  but the function is architecturally inconsistent: any developer adding code between L489 and L568 could
  inadvertently write to the ledger before the guard fires.

- **F2: Dead private function `postEntry` calls `appendLocalLedgerEntry` without any guard — LOW**
  `src/lib/ledger.js:177–217` — `postEntry` is a private (non-exported) helper that calls
  `appendLocalLedgerEntry` (L207) and `scheduleRemotePersist` (L213) with no guard check. It is currently
  **dead code**: `postTransaction` (its former caller) no longer routes through it; no other function in
  `ledger.js` calls it. If `postEntry` were accidentally re-introduced into a call chain, it would write
  to the local ledger and trigger a remote persist without any guard gate.

- **F3: `appendLocalLedgerEntry` has no intrinsic guard — MEDIUM**
  `src/lib/localLedgerStore.js:87` — The only exported write function for the `zuri_local_ledger_v1`
  localStorage key carries no `clientLedgerGuard` check. The module is not responsible for policy
  enforcement by design, but this means every future caller must independently remember to call the guard.
  All current callers do so correctly; future callers present a latent defense-in-depth gap.

- **F4: `stressTest.js` writes a ledger-shaped localStorage key without any guard — LOW**
  `src/lib/stressTest.js:17,41,60` — Writes to `localStorage.setItem('ledger_entries', ...)`. The key
  `ledger_entries` does **not** match the current active ledger key `zuri_local_ledger_v1`; these writes
  are stale (legacy key) and are not read by `localLedgerStore.readRaw()`. All write paths in
  `stressTest.js` are gated by `import.meta.env.MODE !== 'development'` early-return (L65, L85). No
  functional impact on the live ledger. The key name mismatch means `DiagnosticsBadge.jsx` (which still
  checks `ledger_entries`) may display false-positive state.

- **F5: Telemetry precedes guard in `src/api/ledger.js:postTransaction` — INFORMATIONAL**
  `obs.startTrace(...)` at L15 runs before `isClientDemoLedgerAllowed()` at L17. This is observability
  only; no ledger write or sensitive side-effect occurs before the guard. Risk is cosmetic but the pattern
  differs from the other five callsites.

---

## localStorage writes with key matching `/zuri_.*ledger/i`

| File | Line | Key | Gated? |
|---|---|---|---|
| `src/lib/localLedgerStore.js` | 43 | `zuri_local_ledger_v1` | No intrinsic guard — relies on all callers to gate (F3 above) |
| `src/lib/localLedgerStore.js` | 59 | `zuri_local_ledger_seq_v1` | Same — sequence counter written by `nextSeq()`, called only from `appendLocalLedgerEntry` |

No other file in `src/` writes a key matching `/zuri_.*ledger/i`. (`stressTest.js` writes `ledger_entries`, which does **not** match the pattern and is a different, legacy key.)

---

## `localLedgerStore.js` — exported write function analysis

| Export | Type | Gated by clientLedgerGuard? | Protection |
|---|---|---|---|
| `appendLocalLedgerEntry` | **Write** (localStorage) | **No intrinsic guard** | Relies on all callers to hold the guard before calling. All current callers are correctly gated (see Callsites table). |
| `__setLocalLedgerTestState` | Write (in-memory only) | No | Test-only; writes to `testMemory` (never touches localStorage). Not a production concern. |
| `__clearLocalLedgerTestState` | Write (in-memory only) | No | Same as above. |
| `readAllLocalLedgerEntries` | Read | n/a | No write path. |
| `findLocalEntriesByTransactionRef` | Read | n/a | No write path. |
| `getLocalEntriesForAccountPhone` | Read | n/a | No write path. |
| `ledgerEntryDedupeKey` | Pure function | n/a | No side effects. |

`appendLocalLedgerEntry` is the only exported function that mutates `zuri_local_ledger_v1`. It has no
intrinsic guard. The private `writeRaw` function (which it delegates to) also has no guard.

---

## Bypass paths discovered

**No active bypass paths found.**

The only code path that calls `appendLocalLedgerEntry` without first passing through a guard is the dead
private function `postEntry` (F2). Because `postEntry` is not reachable from any exported function or
component, no live execution path can write to the local ledger without triggering the guard.

The guard on `reverseTransaction` fires transitively (via `postDoubleEntryAtomic`) rather than at the
function entry, but because `postDoubleEntryAtomic` throws before the `appendLocalLedgerEntry` calls at
L578/584, no ledger write escapes in a blocked environment.

---

## Recommended next actions

1. **Add `assertClientLedgerPostingAllowed()` as the first statement of `reverseTransaction`** (F1).
   This closes the architectural inconsistency and ensures no future code inserted above L568 can write
   to the ledger ungated. Low-effort, no behavior change in current code.

2. **Delete the dead `postEntry` function** (F2) from `src/lib/ledger.js`. It is not called, carries no
   guard, and is a trap for future developers. Removing it eliminates the latent bypass risk entirely.

3. **Add a guard assertion inside `appendLocalLedgerEntry`** (F3) as a last-resort defense:
   ```js
   export function appendLocalLedgerEntry(entry) {
     assertClientLedgerPostingAllowed(); // defense-in-depth
     // ... existing body
   }
   ```
   This makes the storage layer self-protecting and removes the requirement that every present and future
   caller remember to gate independently. Negligible overhead (guard is a synchronous boolean read).

4. **Update `stressTest.js` to use `zuri_local_ledger_v1`** (F4) or remove the `ledger_entries` writes
   entirely if the legacy key is no longer read anywhere. Fix the `DiagnosticsBadge.jsx` check accordingly.
   Low-urgency; no security impact, only stale-key confusion.

5. **Prompt 2.5 scope**: Prompts 2.1 (F1) + 2.2 (F2) + 2.3 (F3 guard addition) map cleanly to a single
   hardening PR. The most impactful single change is #3 (intrinsic guard on `appendLocalLedgerEntry`)
   because it makes the guard unconditionally active regardless of call-site hygiene. Combined with #1
   and #2, the guard becomes impossible to bypass through either live code or future regressions.
   Recommend Prompt 2.5 implement all three.

---

## Resolution (Prompt 2.5)

- **F1: RESOLVED** — `assertClientLedgerPostingAllowed()` added as the first statement of `reverseTransaction`, with a belt-and-braces comment (`src/lib/ledger.js`). The guard at `postDoubleEntryAtomic` is now redundant-by-design; any code inserted between the function entry and the RPC call is automatically protected.
- **F2: RESOLVED** — Dead private function `postEntry` deleted from `src/lib/ledger.js`. Confirmed zero callers via grep before deletion. Git history is the record.
- **F3: RESOLVED** — `assertClientLedgerPostingAllowed()` is now the first statement of `appendLocalLedgerEntry` (`src/lib/localLedgerStore.js`). Client ledger writes are no longer protectable by call-site discipline alone; the storage layer is self-protecting.
- **F4: DEFERRED** — Legacy `stressTest.js` key mismatch (`ledger_entries` vs `zuri_local_ledger_v1`), low priority, no security impact.
- **F5: INFO** — Telemetry-before-guard in `src/api/ledger.js:postTransaction` is observability-only; no action needed.
