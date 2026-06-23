# Core Money-Path Security Audit — Pass 2 (read-only)

## Context
Read-only security review of the Zuri core money path (NOT chama, which was pass 1):
the double-entry ledger, Daraja STK push initiation, the callback/webhook handler,
and reconciliation. Audited against standard M-Pesa/Daraja doctrine (callbacks are
unsigned → IP allowlist + URL/HMAC secret + re-query confirmation; treat callback as
a trigger not truth; dedup on CheckoutRequestID; never trust callback amount; ledger
service-role-only & append-only). **No code was changed.** This file is the findings
report for triage only.

This document is self-contained: each finding below carries the concrete exploit /
failure scenario and the file:line evidence, verified by re-reading the referenced
code on 2026-06-23. Line numbers are as of that read.

## Files read
- supabase/functions/webhook-handler/index.ts
- supabase/functions/initiate-payment/index.ts
- supabase/functions/_shared/{webhook-verify,payment-lifecycle,daraja-stk,daraja-query,payment-env,function-env,stuck-payments,provider-status-applier}.ts
- supabase/functions/reconciliation-job/index.ts
- migrations: atomic_double_entry, ledger_accounts_and_hash_chain, ledger_concurrency_hardening,
  server_authoritative_ledger, rls_lockdown, mpesa_payment_lifecycle_hardening,
  idempotency_keys, security_rls_hardening, init_zuri_schema

## Per-question verdicts
1. Callback authenticity — **PARTIAL** (HMAC fail-closed in prod; IP layer spoofable; doctrine misleading)
2. Idempotency under replay — **CONFIRMED SAFE** (triple-layer dedup)
3. Ledger integrity — **CONFIRMED SAFE** (debit==credit + append-only trigger; chain verify is on-demand only)
4. Out-of-order / impossible states — **CONFIRMED SAFE**
5. Amount / account trust — **CONFIRMED SAFE** (server-authoritative amount)
6. Reconciliation gaps — **PARTIAL** (one pre-persist orphan gap; no double-settle path)
7. Secrets & transport — **CONFIRMED SAFE** (minor provider-error leakage to user)

---

## Findings (highest → lowest)

None are auto-fixed — all await triage. Severity ranking is unchanged from the
summary pass.

### MED-1 — IP allowlist trusts the leftmost (client-controlled) X-Forwarded-For entry

**Evidence**
- `webhook-handler/index.ts:202-204` derives the source IP:
  ```ts
  const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown';
  ```
  It takes `split(',')[0]` — the **leftmost** value of the `X-Forwarded-For` chain.
- `webhook-handler/index.ts:101-103` (`isAllowedSafaricomIp`) and `:85-99`
  (`ipMatchesCidr`) test that string against `SAFARICOM_IP_RANGES` (`:70-83`).
- The gate that consumes it is `webhook-handler/index.ts:247`:
  ```ts
  if (provider === 'mpesa' && !skipState.skipIpEffective && !isAllowedSafaricomIp(clientIp)) { … return 403 }
  ```

**Exploit scenario (step by step)**
1. `X-Forwarded-For` is a request header. The *leftmost* entry is whatever the
   *original client* sent; trustworthy proxies (Supabase edge) *append* the real
   peer IP to the right. Trusting the leftmost entry means trusting the caller.
2. An attacker POSTs directly to the public function URL with header
   `X-Forwarded-For: 196.201.214.206` (a value inside `SAFARICOM_IP_RANGES`).
3. Line 202 evaluates `split(',')[0].trim()` → `"196.201.214.206"`.
4. `isAllowedSafaricomIp` matches the `/32` CIDR and returns `true`; the line 247
   gate passes. The IP allowlist — the layer the doctrine leans on for
   authenticity (see MED-2) — provides effectively zero protection against a
   direct attacker.
5. The correct value to evaluate is the rightmost/trusted-proxy-appended entry (or
   a platform-provided trusted client-IP), not the leftmost.

**Triage decision:** fix together with MED-2 / INFO-8 (callback authenticity
fail-closed). Spoofable IP is only dangerous because it is the doctrine's
fallback "authenticity" layer; the three must be hardened as one unit.

---

### MED-2 — Authenticity depends on an out-of-band HMAC gateway that is not in the repo; the "IP-only" fallback is unsupported by the code

**Evidence**
- The strategy comment `webhook-handler/index.ts:30-37` states the design
  explicitly: Daraja does **not** sign callbacks out of the box, so operators
  must "front the function behind a gateway that signs … OR rely on the IP
  allowlist + CheckoutRequestID matching."
- The only crypto check is the HMAC path `webhook-handler/index.ts:260-273`:
  ```ts
  const skipSignature = skipState.skipSignatureEffective;
  if (!skipSignature) {
    const secret = Deno.env.get(provider === 'mpesa' ? 'MPESA_WEBHOOK_SECRET' : 'WEBHOOK_SECRET') || '';
    const verification = await verifyWebhookSignature(rawBody, signature, timestamp, secret);
    if (!verification.valid) { … return 401 }
  }
  ```
- `webhook-verify.ts:30-32` is fail-closed: a missing signature header or an
  unset secret returns `{ valid: false }`:
  ```ts
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  if (!secret) return { valid: false, reason: 'no_secret_configured' };
  ```

**Failure / exploit scenario (step by step)**
1. In production, skip flags are refused (see INFO-8 for the gap), so
   `skipSignature` is `false` and the HMAC path runs.
2. Daraja's real callbacks are **unsigned**. So unless an out-of-band gateway (not
   present anywhere in this repo) injects a valid `x-mpesa-signature`, one of two
   bad outcomes holds:
   - **(a) `MPESA_WEBHOOK_SECRET` is set, no signing gateway exists.** Every
     genuine Daraja callback arrives without a signature → `verifyWebhookSignature`
     returns `missing_signature` → `401` at line 271. No payment ever finalizes;
     the ledger is never posted from the happy path. This is an availability /
     stuck-funds failure, silently, in production.
   - **(b) Operator "relies on IP allowlist" (the documented fallback).** With no
     signature requirement, the *only* authenticity layer is the IP check — which
     MED-1 shows is bypassable by spoofing `X-Forwarded-For`. An attacker who can
     supply a valid `CheckoutRequestID`, `Amount`, and `PhoneNumber` matching a
     real pending row (these are the only remaining checks, in
     `payment-lifecycle.ts:271-275`) can forge a `ResultCode: 0` success callback
     and drive a ledger post. CheckoutRequestID is thus the de-facto sole secret,
     and it is not a cryptographic one.
3. Net: the system is either fail-closed-to-unavailable (a) or
   authenticity-collapsed (b). The doctrine that "IP + CheckoutRequestID matching"
   substitutes for a signature is not supported by the code, because the IP layer
   is forgeable.

**Triage decision:** fix together with MED-1 / INFO-8 (callback authenticity
fail-closed). The unit of work is: make non-spoofable source verification the
gate, and define one supported authenticity mode (signing proxy *or* a verified
re-query confirmation) rather than an unsupported IP-only fallback.

---

### MED-3 — checkout/merchant IDs are persisted only AFTER the STK call returns → a crash in that window leaves a debited-but-unmatchable orphan

**Evidence**
- `initiate-payment/index.ts:382-411`: the pending row is created earlier
  (`:248-252`) with status `processing`, but `checkout_request_id` /
  `merchant_request_id` are written **only after** `requestDarajaStkPush` returns:
  ```ts
  const stk = await requestDarajaStkPush({ … });          // :383  network call
  …
  await supabaseAdmin.from('pending_payments').update({    // :406-411
    checkout_request_id: stk.checkoutRequestId,
    merchant_request_id: stk.merchantRequestId,
    status: 'waiting_for_mpesa',
    …
  }).eq('id', pending.id);
  ```
- The callback handler resolves the pending row strictly by those IDs —
  `webhook-handler/index.ts:146-164` (`findPendingPayment`) keys on
  `checkout_request_id` then `merchant_request_id`. If neither is set, no match.
- An unmatched callback is treated as an orphan: `webhook-handler/index.ts:382-404`
  marks the `webhook_events` row `failed`, writes a `critical`
  `webhook.orphan` audit event, and returns `404 PENDING_PAYMENT_NOT_FOUND` —
  it never touches the ledger.
- The provider-query reconciliation sweep can only *re-drive* rows that already
  have a checkout id: `reconciliation-job/index.ts:219`
  `.not('checkout_request_id', 'is', null)`. The plain stuck sweep
  (`:113-161`) selects `processing`/`waiting_for_mpesa` rows but has no
  CheckoutRequestID to query Daraja with, so it can only time them out.

**Failure scenario (step by step)**
1. User initiates a payment. The pending row is inserted (`status='processing'`),
   risk passes, and `requestDarajaStkPush` fires the STK push. **Safaricom now
   prompts the user's handset** and the user can complete the payment.
2. After Daraja accepts but **before** line 406 runs, the Edge Function instance
   crashes / times out / the DB UPDATE fails (network drop). The pending row is
   left with `checkout_request_id = NULL`, `merchant_request_id = NULL`,
   `status = 'processing'`.
3. The user pays. Daraja sends the success callback. `findPendingPayment` cannot
   match it (both lookup keys are NULL on the row) → orphan path
   (`:382-404`): `404`, critical audit, no ledger post. The customer is debited at
   M-Pesa with **no corresponding internal ledger entry**.
4. Reconciliation cannot self-heal it: the provider-query sweep skips it
   (`:219`, requires a non-null checkout id), and the stuck sweep has no id to
   query, so the row is eventually marked `timeout` — masking a real, paid
   transaction as a timeout. Resolution is manual-ops only.

**Triage decision:** fix standalone. This needs the M-Pesa doctrine fix —
persist a server-generated correlation key (e.g. `AccountReference` / `tx_ref`,
which Daraja echoes) *before* the STK call and match callbacks on it as a
fallback, so an orphan is always re-linkable. Distinct from the authenticity
batch; do not fold into MED-1/2.

---

### LOW-4 — Hash chain is computed on every post but verified only via a manual service-role RPC

**Evidence**
- `ledger_accounts_and_hash_chain.sql:592-660+` defines `verify_ledger_chain`, a
  `SECURITY DEFINER`, service-role-only function that walks `ledger_entries` in
  `chain_index` order and returns `{ ok: false, reason: 'chain_index_gap' |
  'previous_hash_mismatch', … }` on the first break (`:609-611` guards
  service-role; `:627-649` are the gap / hash-mismatch checks).
- Each post advances the chain head (`ledger_concurrency_hardening.sql:259-261`,
  `:313-315`), so the chain *exists* and is maintained on write.
- A repo-wide search for `verify_ledger_chain` returns only the two migration
  files that define it plus two unit tests — **no Edge Function, cron, or
  scheduled job ever calls it.** Tamper-evidence is therefore latent: nothing
  detects a break unless an operator runs the RPC by hand.

**Failure scenario**
1. A direct DB mutation (compromised service-role key, errant migration, manual
   `UPDATE`) alters or deletes a `ledger_entries` row. The chain's
   `previous_hash` linkage or `chain_index` sequence breaks.
2. Because no automated job calls `verify_ledger_chain`, the break is invisible:
   normal reads, balances, and reconciliation all still function. The
   tamper-evidence property the chain was built for delivers no alert.
3. Detection happens only if/when someone manually invokes the RPC — i.e. likely
   during incident response, after the fact, not proactively.

**Triage decision:** optional scheduled chain-verify. Low urgency (the chain is
correctly maintained on write; this is detection latency, not a corruption bug).
If addressed: add a periodic invocation of `verify_ledger_chain` (e.g. in the
reconciliation cron) that raises an audit/alert on `ok:false`.

---

### LOW-5 — Non-integer KES amounts guarantee an amount-mismatch / review; STK sends `Math.ceil` while the stored amount keeps 2 decimals

**Evidence**
- `payment-lifecycle.ts:53-57` (`normalizeMoneyAmount`) rounds to **2 decimal
  places** and that value is what gets stored on the pending row:
  ```ts
  return Math.round((n + Number.EPSILON) * 100) / 100;
  ```
  (`buildPendingPaymentRecord` at `:68` calls it and stores `amount` verbatim.)
- `daraja-stk.ts:70` sends a **ceiled integer** to Daraja:
  ```ts
  Amount: Math.ceil(Number(amount)),
  ```
- The callback's `Amount` (what M-Pesa actually moved — the ceiled integer) is
  compared against the stored 2-dp pending amount in `payment-lifecycle.ts:173-176`
  (`compareAmount`, exact `round()`-equality) and consumed at `:271, :275` via
  `successVerificationFailed`. Mismatch → `review_required`, no ledger post
  (`:410-436`).

**Failure scenario (step by step)**
1. A user initiates a payment of e.g. `100.50` KES. The pending row stores
   `amount = 100.5` (`normalizeMoneyAmount`).
2. The STK push sends `Amount = Math.ceil(100.5) = 101` (`daraja-stk.ts:70`).
   M-Pesa debits **101**.
3. The success callback reports `Amount: 101`. `compareAmount(101, 100.5)` →
   `round(101) !== round(100.5)` → `false`.
4. `successVerificationFailed` is true → the payment is held `review_required`
   with **no ledger post** (`payment-lifecycle.ts:410-436`), even though it
   succeeded at M-Pesa. Every fractional-KES payment deterministically lands in
   the manual-review queue, and the customer paid 1 KES more than recorded.

**Triage decision:** hygiene batch (with LOW-6 / INFO-7). Fix by enforcing
integer KES end-to-end (reject or floor/round at intake so the stored amount,
the STK `Amount`, and the callback `Amount` are the same integer).

---

### LOW-6 — Raw Daraja initiation error body is stored in `pending_payments.result_desc`, which is user-readable

**Evidence**
- `initiate-payment/index.ts:414-420` (the catch around the STK push) writes the
  raw exception message into `result_desc`:
  ```ts
  } catch (error) {
    await supabaseAdmin.from('pending_payments').update({
      status: 'failed',
      result_code: 'INITIATION_FAILED',
      result_desc: error instanceof Error ? error.message : 'Unknown initiation failure',  // :418
      …
    }).eq('id', pending.id);
  ```
- The thrown messages embed verbatim Daraja HTTP bodies:
  `daraja-stk.ts:81` `throw new Error(\`STK Push failed ${stkRes.status}: ${await stkRes.text()}\`)`
  and `:9` `throw new Error(\`Daraja OAuth failed ${res.status}: ${await res.text()}\`)`.
- `pending_payments` rows are owner-readable (the initiating user can read their
  own row's `result_desc`), so the provider's raw response — potentially shortcode
  details, internal error phrasing, or token-endpoint diagnostics — is surfaced to
  the end user. Contrast the deliberately sanitized path in `daraja-query.ts`
  (`sanitizeResultDesc`, `:137-140`) used for the *query* flow.

**Failure scenario**
1. The STK push or OAuth call fails. `daraja-stk.ts` throws with the raw provider
   body interpolated into the message.
2. `initiate-payment/index.ts:418` persists that whole string into
   `result_desc` on the user's pending row.
3. The user reads their own pending payment and sees internal provider
   diagnostics — an information-disclosure / log-poisoning footgun. No financial
   impact, but it leaks provider internals and is inconsistent with the sanitized
   query path.

**Triage decision:** hygiene batch (with LOW-5 / INFO-7). Fix by storing a
generic code/message in `result_desc` and keeping the raw provider text in a
service-only field (or running it through `sanitizeResultDesc`).

---

### INFO-7 — `lock_pending_payment_for_finalization` is defined but never called

**Evidence**
- `ledger_concurrency_hardening.sql:95-110` defines
  `lock_pending_payment_for_finalization(p_id UUID)`, a service-role-only
  `pg_advisory_xact_lock` helper, documented (`:115-116`) as the "single, safe
  way to serialise concurrent callbacks for one payment."
- A repo-wide search for `lock_pending_payment_for_finalization` returns only the
  defining migration and two unit tests — **the webhook handler never calls it.**
  `webhook-handler/index.ts` finalizes (`:590-599` non-chama via
  `finalizeDarajaPayment`; `:494-537` chama via `settle_chama_contribution`)
  without ever taking the per-payment lock.

**Why this is only INFO (not a live double-post bug)**
- The actual double-post defenses are elsewhere and *are* wired up:
  the `webhook_events.idempotency_key` UNIQUE de-dup
  (`webhook-handler/index.ts:331-377`), the per-`transaction_ref`
  `pg_advisory_xact_lock` *inside* `post_double_entry`
  (`ledger_concurrency_hardening.sql:170`), and the
  `ledger_idempotency_keys` result cache (`:172-188, :326-348`). Concurrent
  callbacks for one payment are serialized at the ledger layer regardless.
- So `lock_pending_payment_for_finalization` is dead code: a safety primitive
  that was built and granted but never invoked. It is noise that implies a
  protection the call sites do not actually use.

**Triage decision:** hygiene batch (with LOW-5 / LOW-6). Either wire it into the
webhook finalization path (defense-in-depth at the row level) or remove it so the
codebase does not imply a lock that is never taken.

---

### INFO-8 — `DARAJA_ENV=sandbox` short-circuits the skip-flag gate regardless of `APP_ENV`, re-enabling skip flags in a prod-like deployment

**Evidence**
- `payment-env.ts:65-75` (`areWebhookSkipFlagsAllowed`):
  ```ts
  export function areWebhookSkipFlagsAllowed(): boolean {
    const daraja = getDarajaEnv();
    if (daraja === 'production') return false;          // :67
    const app = getAppEnv();
    if (app === 'production' || app === 'staging') return false;  // :70
    if (daraja === 'sandbox') return true;              // :73  ← short-circuits
    return NON_PROD_APP_ENVS.includes(app);             // :74
  }
  ```
- The header comment (`:62-63`) states the intended invariant: "`'unknown'` is
  treated as production for skip-flag purposes — fail closed when env config is
  missing." Line 73 violates that invariant whenever `DARAJA_ENV=sandbox`.
- Consumed by `resolveWebhookSkipFlags` (`:98-113`), whose
  `skipSignatureEffective` / `skipIpEffective` (`:107-108`) gate the HMAC check
  (`webhook-handler/index.ts:260`) and the IP check (`:247`); only
  `refusedInProduction` (`:109`) triggers the hard reject at `:215-245`.

**Failure / exploit scenario (step by step)**
1. Line 70 only catches `APP_ENV` *explicitly* set to `production`/`staging`. If
   `APP_ENV` is unset or misspelled, `getAppEnv()` returns `'unknown'` — which the
   comment says must be treated as production.
2. But line 73 returns `true` for `DARAJA_ENV=sandbox` **before** line 74 ever
   consults `NON_PROD_APP_ENVS`. So a deployment with `DARAJA_ENV=sandbox` and
   `APP_ENV` unset/unknown is deemed "safe to bypass."
3. Such a deployment is realistic: a prod-like environment pointed at Daraja
   sandbox for a soak test, or an operator who set `DARAJA_ENV=sandbox` but forgot
   `APP_ENV`. If `WEBHOOK_SKIP_SIGNATURE=true` and/or `WEBHOOK_SKIP_IP_CHECK=true`
   are also set, `skipSignatureEffective` / `skipIpEffective` become true.
4. With skips effective, the HMAC gate (`webhook-handler/index.ts:260-273`) and
   the IP gate (`:247`) are **both bypassed** — any unauthenticated POST with a
   well-formed Daraja body and a known CheckoutRequestID can finalize a payment.
   The `refusedInProduction` rejection (`:215`) never fires because
   `areWebhookSkipFlagsAllowed()` returned true.

**Triage decision:** fix together with MED-1 / MED-2 (callback authenticity
fail-closed). The fix: do not let `DARAJA_ENV=sandbox` alone grant the bypass —
require an explicit non-prod `APP_ENV` (move line 73 below the
`NON_PROD_APP_ENVS` check, or require both), so `'unknown'` genuinely fails
closed as the comment promises.
