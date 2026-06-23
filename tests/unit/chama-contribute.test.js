/**
 * chama-contribute Edge Function — structural assertions
 *
 * The function runs under Deno and cannot be imported in Vitest/Node.
 * These tests read the source as text and assert that each guard, amount
 * derivation, idempotency rule, and state-machine transition is correctly
 * wired. Pattern mirrors tests/unit/initiate-payment-provider-gate.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(
  process.cwd(),
  'supabase/functions/chama-contribute/index.ts',
);
const src = readFileSync(SOURCE_PATH, 'utf8');

// ── Amount derivation ───────────────────────────────────────────────────────

describe('chama-contribute: server-side amount derivation', () => {
  it('reads amount_due_cents from the obligation row', () => {
    expect(src).toContain('amount_due_cents');
  });

  it('divides amount_due_cents by 100 to get KES (exact integer division)', () => {
    expect(src).toMatch(/amount_due_cents.*\/.*100|Number\(ob\.amount_due_cents\)\s*\/\s*100/s);
  });

  it('amount is not read from the request body — body.amount is intentionally ignored', () => {
    // The only text reference to body.amount in the source must be the comment
    // documenting that it is ignored. It must never appear in an assignment or
    // arithmetic expression.
    expect(src).not.toMatch(/Number\s*\(\s*body\.amount/);
    expect(src).not.toMatch(/parseFloat\s*\(\s*body\.amount/);
    expect(src).not.toMatch(/parseInt\s*\(\s*body\.amount/);
    expect(src).not.toMatch(/const\s+\w+\s*=\s*body\.amount/);
    expect(src).not.toMatch(/let\s+\w+\s*=\s*body\.amount/);
    expect(src).not.toMatch(/amount:\s*body\.amount/);
  });

  it('comment documents that body.amount is intentionally ignored', () => {
    expect(src).toMatch(/body\.amount is intentionally ignored/i);
  });
});

// ── CORS and method guard ──────────────────────────────────────────────────

describe('chama-contribute: CORS and method guard', () => {
  it('returns null response for OPTIONS preflight with corsHeaders', () => {
    expect(src).toMatch(/req\.method.*OPTIONS.*corsHeaders|OPTIONS.*new Response.*null.*corsHeaders/s);
  });

  it('rejects non-POST with 405 METHOD_NOT_ALLOWED', () => {
    expect(src).toContain('METHOD_NOT_ALLOWED');
    expect(src).toContain('405');
  });

  it('CORS origin is set from APP_ORIGIN env var, never a wildcard *', () => {
    expect(src).toContain('APP_ORIGIN');
    expect(src).not.toMatch(/['"]Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/);
  });
});

// ── JWT authentication ──────────────────────────────────────────────────────

describe('chama-contribute: JWT authentication', () => {
  it('extracts JWT from Authorization: Bearer header', () => {
    expect(src).toContain('Authorization');
    expect(src).toMatch(/Bearer/i);
  });

  it('calls supabaseAdmin.auth.getUser(jwt)', () => {
    expect(src).toContain('auth.getUser(jwt)');
  });

  it('returns 401 MISSING_AUTHORIZATION when no JWT is present', () => {
    expect(src).toContain('MISSING_AUTHORIZATION');
    expect(src).toMatch(/MISSING_AUTHORIZATION.*401|401.*MISSING_AUTHORIZATION/s);
  });

  it('returns 401 INVALID_TOKEN when JWT is invalid', () => {
    expect(src).toContain('INVALID_TOKEN');
  });

  it('uses SUPABASE_SERVICE_ROLE_KEY (service_role client), not anon key', () => {
    expect(src).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(src).not.toContain('SUPABASE_ANON_KEY');
  });
});

// ── Obligation guard rails ─────────────────────────────────────────────────

describe('chama-contribute: obligation guard rails', () => {
  it('returns 404 OBLIGATION_NOT_FOUND when obligation row is missing', () => {
    expect(src).toContain('OBLIGATION_NOT_FOUND');
    expect(src).toMatch(/OBLIGATION_NOT_FOUND.*404|404.*OBLIGATION_NOT_FOUND/s);
  });

  it('uses OBLIGATION_NOT_FOUND for the wrong-user case (no info leak)', () => {
    // Two separate 404 returns for: (a) row not found, (b) member.user_id mismatch.
    // Must not use a distinct error that reveals the obligation exists.
    const matches = (src.match(/OBLIGATION_NOT_FOUND/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  it('compares member.user_id to authUserId for ownership check', () => {
    expect(src).toMatch(/member\.user_id.*authUserId|authUserId.*member\.user_id/s);
  });

  it('returns 403 MEMBER_NOT_ACTIVE when member status is not active', () => {
    expect(src).toContain('MEMBER_NOT_ACTIVE');
    expect(src).toMatch(/MEMBER_NOT_ACTIVE.*403|403.*MEMBER_NOT_ACTIVE/s);
  });

  it('checks member.status === "active"', () => {
    expect(src).toMatch(/member\.status.*['"']active['"']|['"']active['"'].*member\.status/);
  });

  it('returns 409 GROUP_NOT_ACTIVE when group status is not active', () => {
    expect(src).toContain('GROUP_NOT_ACTIVE');
    expect(src).toMatch(/GROUP_NOT_ACTIVE.*409|409.*GROUP_NOT_ACTIVE/s);
  });

  it('returns 409 CYCLE_NOT_OPEN when cycle status is not open', () => {
    expect(src).toContain('CYCLE_NOT_OPEN');
    expect(src).toMatch(/CYCLE_NOT_OPEN.*409|409.*CYCLE_NOT_OPEN/s);
  });

  it('returns 409 OBLIGATION_NOT_AVAILABLE when obligation status is not due', () => {
    expect(src).toContain('OBLIGATION_NOT_AVAILABLE');
    expect(src).toMatch(/OBLIGATION_NOT_AVAILABLE.*409|409.*OBLIGATION_NOT_AVAILABLE/s);
  });

  it('checks ob.status === "due" before allowing contribution', () => {
    expect(src).toMatch(/ob\.status.*['"']due['"']|['"']due['"'].*ob\.status/);
  });
});

// ── Phone gate ─────────────────────────────────────────────────────────────

describe('chama-contribute: phone gate', () => {
  it('calls normalizePhone on the from_phone request field', () => {
    expect(src).toContain('normalizePhone');
    expect(src).toMatch(/normalizePhone.*fromPhoneRaw|normalizePhone.*from_phone/);
  });

  it('normalizes the auth user phone for comparison', () => {
    expect(src).toContain('profilePhone');
    expect(src).toMatch(/normalizePhone.*authPhone/);
  });

  it('compares normalizedFromPhone against profilePhone', () => {
    expect(src).toMatch(/profilePhone.*normalizedFromPhone|normalizedFromPhone.*profilePhone/);
  });

  it('returns 403 PHONE_MISMATCH on mismatch', () => {
    expect(src).toContain('PHONE_MISMATCH');
    expect(src).toMatch(/PHONE_MISMATCH.*403|403.*PHONE_MISMATCH/s);
  });

  it('returns 403 PROFILE_INCOMPLETE when auth user has no verified phone', () => {
    expect(src).toContain('PROFILE_INCOMPLETE');
  });

  it('does NOT log the full phone number in the mismatch warning', () => {
    // Only user_id is logged — never the phone value itself.
    expect(src).not.toMatch(/console\.\w+\([^)]*normalizedFromPhone/);
    expect(src).not.toMatch(/console\.\w+\([^)]*profilePhone/);
    expect(src).not.toMatch(/console\.\w+\([^)]*authPhone/);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe('chama-contribute: rate limiting', () => {
  it('uses the atomic check_rate_limit RPC with a 1-hour (3600s) window', () => {
    expect(src).toMatch(/checkRateLimit\([^)]*\b3600\b[^)]*\)/);
  });

  it('enforces a limit of 5 payments per user per hour', () => {
    expect(src).toMatch(/checkRateLimit\([^)]*,\s*5\s*,\s*3600\b/);
  });

  it('returns 429 RATE_LIMITED when over the limit', () => {
    expect(src).toContain('RATE_LIMITED');
    expect(src).toMatch(/RATE_LIMITED.*429|429.*RATE_LIMITED/s);
  });

  it('rate-limit uses a per-user bucket keyed on authUserId with a distinct endpoint', () => {
    expect(src).toMatch(
      /checkRateLimit\(\s*supabaseAdmin\s*,\s*authUserId\s*,\s*['"]user['"]\s*,\s*['"]chama_contribute['"]/,
    );
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────

describe('chama-contribute: idempotency', () => {
  it('uses a stable server-derived key: chama_contrib_{obligation_id}', () => {
    expect(src).toMatch(/`chama_contrib_\$\{obligationId\}/);
  });

  it('in-flight check is obligation-centric: queries metadata->>obligation_id and user_id', () => {
    // Must find any pending row for this obligation — not just the stable-key row —
    // so a retry row (disambiguated key) also blocks a duplicate STK push.
    expect(src).toMatch(/\.eq\s*\(\s*['"]metadata->>obligation_id['"]\s*,\s*obligationId\s*\)/);
    expect(src).toMatch(/\.eq\s*\(\s*['"]user_id['"]\s*,\s*authUserId\s*\)/);
  });

  it('in-flight check orders by created_at DESC to find the most recent attempt', () => {
    expect(src).toMatch(/\.order\s*\(\s*['"]created_at['"]\s*,\s*\{[^}]*ascending[^}]*false/s);
  });

  it('returns duplicate:true with pending_payment_id when an in-flight row is found', () => {
    expect(src).toContain('duplicate: true');
    expect(src).toContain('pending_payment_id: existingPayment.id');
  });

  it('does NOT fire a second STK push when a duplicate is found', () => {
    // The duplicate return must come BEFORE the requestDarajaStkPush function CALL.
    // We search for 'await requestDarajaStkPush' to skip the import declaration.
    const dupReturnIdx = src.indexOf('duplicate: true');
    const stkCallIdx   = src.indexOf('await requestDarajaStkPush');
    expect(dupReturnIdx).toBeGreaterThan(-1);
    expect(stkCallIdx).toBeGreaterThan(-1);
    expect(dupReturnIdx).toBeLessThan(stkCallIdx);
  });

  it('allows retry when existing row is terminal-failed (TERMINAL_FAILURE_STATUSES check)', () => {
    expect(src).toContain('TERMINAL_FAILURE_STATUSES');
    expect(src).toMatch(/TERMINAL_FAILURE_STATUSES\.has\(existingPayment\.status\)/);
  });

  it('uses a time-disambiguated retry key so failed rows are preserved for audit', () => {
    expect(src).toMatch(/STABLE_KEY.*_r.*Date\.now|`\$\{STABLE_KEY\}_r\$\{Date\.now/s);
  });

  it('never stores body.idempotency_key directly into pending_payments', () => {
    // The pending record must use idempotencyKey (server-derived), not a
    // field read from the request body.
    expect(src).not.toMatch(/idempotency_key:\s*body\.idempotency_key/);
    expect(src).not.toMatch(/idempotency_key:\s*String\s*\(\s*body\.idempotency_key/);
  });
});

// ── Pending payment record shape ───────────────────────────────────────────

describe('chama-contribute: pending_payments record shape', () => {
  it('sets payment_type to "chama_contribution"', () => {
    expect(src).toContain("payment_type:    'chama_contribution'");
  });

  it('sets to_phone as the CHAMA:<group_id> sentinel', () => {
    expect(src).toMatch(/to_phone:\s*`CHAMA:\$\{groupId\}`/);
  });

  it('sets credit_account_type: "savings" in metadata', () => {
    expect(src).toContain("credit_account_type: 'savings'");
  });

  it('stores obligation_id, group_id, member_id in metadata', () => {
    const metaBlock = src.slice(src.indexOf('metadata:'), src.indexOf('metadata:') + 300);
    expect(metaBlock).toContain('obligation_id:');
    expect(metaBlock).toContain('group_id:');
    expect(metaBlock).toContain('member_id:');
  });

  it('tx_ref starts with CC- and includes the obligation_id prefix', () => {
    expect(src).toMatch(/`CC-\$\{obligationId\.slice\(0,\s*8\)/);
  });

  it('does NOT call buildPendingPaymentRecord (incompatible with sentinel to_phone and absent body.amount)', () => {
    expect(src).not.toContain('buildPendingPaymentRecord(');
  });

  it('uses amountKes (server-derived) for the amount field, not body.*', () => {
    expect(src).toMatch(/amount:\s*amountKes/);
  });
});

// ── Optimistic concurrency on obligation ───────────────────────────────────

describe('chama-contribute: optimistic concurrency', () => {
  it('UPDATE chama_obligations includes WHERE status="due" guard', () => {
    expect(src).toMatch(/\.eq\s*\(\s*['"]status['"]\s*,\s*['"]due['"]\s*\)/);
  });

  it('UPDATE sets status to pending_payment and writes payment_tx_ref', () => {
    expect(src).toMatch(/status.*pending_payment.*payment_tx_ref|payment_tx_ref.*status.*pending_payment/s);
  });

  it('uses .select("id") to detect 0-row UPDATE result (race condition)', () => {
    expect(src).toMatch(/\.select\s*\(\s*['"]id['"]\s*\)/);
    expect(src).toMatch(/updateResult\.length\s*===\s*0/);
  });

  it('deletes the orphaned pending_payments row when the race is detected', () => {
    const raceIdx = src.indexOf('obligation_race_concurrency');
    const srcBefore = src.slice(Math.max(0, raceIdx - 400), raceIdx + 10);
    expect(srcBefore).toMatch(/\.delete\(\)\.eq\s*\(\s*['"]id['"]\s*,\s*pending\.id\s*\)/);
  });

  it('returns 409 OBLIGATION_NOT_AVAILABLE on race condition', () => {
    // At least one OBLIGATION_NOT_AVAILABLE returns after the race detection.
    const raceIdx   = src.indexOf('obligation_race_concurrency');
    const afterRace = src.slice(raceIdx);
    expect(afterRace).toContain('OBLIGATION_NOT_AVAILABLE');
  });
});

// ── STK push and obligation state machine ─────────────────────────────────

describe('chama-contribute: STK push and state transitions', () => {
  it('fires STK push AFTER the optimistic obligation UPDATE', () => {
    // Use 'await requestDarajaStkPush' to target the call site, not the import.
    const updateIdx  = src.indexOf("status: 'pending_payment'");
    const stkCallIdx = src.indexOf('await requestDarajaStkPush');
    expect(updateIdx).toBeGreaterThan(-1);
    expect(stkCallIdx).toBeGreaterThan(-1);
    expect(stkCallIdx).toBeGreaterThan(updateIdx);
  });

  it('wraps requestDarajaStkPush in try/catch (the function throws on network failure)', () => {
    const stkIdx   = src.indexOf('requestDarajaStkPush');
    const catchIdx = src.indexOf('} catch', stkIdx);
    expect(stkIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(stkIdx);
  });

  it('on stk.ok=true: sets checkout_request_id, merchant_request_id, status=waiting_for_mpesa', () => {
    expect(src).toContain('checkout_request_id: stk.checkoutRequestId');
    expect(src).toContain('merchant_request_id: stk.merchantRequestId');
    expect(src).toContain("status:              'waiting_for_mpesa'");
  });

  it('on stk.ok=false: marks pending_payment failed and returns 422 STK_PUSH_FAILED', () => {
    expect(src).toContain('STK_PUSH_FAILED');
    expect(src).toMatch(/STK_PUSH_FAILED.*422|422.*STK_PUSH_FAILED/s);
    expect(src).toMatch(/status:\s*['"]failed['"]/);
  });

  it('on STK failure: resets obligation to status=due and payment_tx_ref=null', () => {
    // Must reset both fields so the member can retry.
    expect(src).toMatch(/status:\s*'due',\s*payment_tx_ref:\s*null/s);
  });

  it('obligation reset on STK failure is guarded by payment_tx_ref=txRef', () => {
    // Prevents resetting an obligation stamped by a different concurrent attempt.
    expect(src).toMatch(/\.eq\s*\(\s*['"]payment_tx_ref['"]\s*,\s*txRef\s*\)/);
  });

  it('on network error (throw): also resets obligation to due with null payment_tx_ref', () => {
    // Use 1200 chars to cover the full catch block (pending update + obligation reset).
    const catchIdx   = src.lastIndexOf('} catch');
    const catchBlock = src.slice(catchIdx, catchIdx + 1200);
    expect(catchBlock).toMatch(/status:\s*'due',\s*payment_tx_ref:\s*null/s);
  });

  it('success response contains pending_payment_id and tx_ref', () => {
    expect(src).toContain('pending_payment_id: pending.id');
    expect(src).toContain('tx_ref: txRef');
    expect(src).toMatch(/ok:\s*true/);
  });
});

// ── Failed-then-retry scenario ─────────────────────────────────────────────

describe('chama-contribute: failed-then-retry edge case', () => {
  it('TERMINAL_FAILURE_STATUSES set includes failed, cancelled, and timeout', () => {
    expect(src).toMatch(/TERMINAL_FAILURE_STATUSES\s*=\s*new Set\s*\(\s*\[/);
    const setBlock = src.slice(
      src.indexOf('TERMINAL_FAILURE_STATUSES = new Set'),
      src.indexOf('TERMINAL_FAILURE_STATUSES = new Set') + 120,
    );
    expect(setBlock).toContain("'failed'");
    expect(setBlock).toContain("'cancelled'");
    expect(setBlock).toContain("'timeout'");
  });

  it('retry path is entered only when TERMINAL_FAILURE_STATUSES.has(existing status)', () => {
    expect(src).toContain('TERMINAL_FAILURE_STATUSES.has(existingPayment.status)');
  });

  it('retry generates a fresh idempotency key to avoid unique-constraint conflict', () => {
    expect(src).toMatch(/idempotencyKey\s*=\s*`\$\{STABLE_KEY\}_r\$\{Date\.now\(\)\}/);
  });

  it('a settled or pending_payment obligation is blocked by step-5 guard before idempotency check', () => {
    // ob.status guard fires at step 5. By the time we reach idempotency (step 9),
    // ob.status is confirmed 'due'. This means a retry is only possible after
    // the reconciliation-job sweep resets the obligation.
    const obStatusIdx = src.indexOf("ob.status !== 'due'");
    const stableKeyIdx = src.indexOf('STABLE_KEY');
    expect(obStatusIdx).toBeGreaterThan(-1);
    expect(stableKeyIdx).toBeGreaterThan(-1);
    expect(stableKeyIdx).toBeGreaterThan(obStatusIdx);
  });
});

// ── Security and logging ───────────────────────────────────────────────────

describe('chama-contribute: security and logging', () => {
  it('uses structured JSON logging with ts, fn, evt, user_id fields', () => {
    expect(src).toMatch(/JSON\.stringify\(\s*\{/);
    expect(src).toMatch(/ts:\s*new Date\(\)\.toISOString\(\)/);
    expect(src).toMatch(/fn:\s*['"]chama-contribute['"]/);
    expect(src).toMatch(/evt:/);
    expect(src).toMatch(/user_id:\s*authUserId/);
  });

  it('never logs the full normalized phone number', () => {
    expect(src).not.toMatch(/console\.\w+\([^)]*normalizedFromPhone/);
    expect(src).not.toMatch(/console\.\w+\([^)]*profilePhone/);
    expect(src).not.toMatch(/console\.\w+\([^)]*authPhone/);
  });

  it('never logs the JWT or the service role key', () => {
    expect(src).not.toMatch(/console\.\w+\([^)]*\bjwt\b/);
    expect(src).not.toMatch(/console\.\w+\([^)]*serviceKey/);
  });

  it('never logs the raw STK push error message from Daraja verbatim in response', () => {
    // Daraja error messages should not be forwarded to the client as-is.
    // They appear in pending_payments.result_desc, not in the JSON response body.
    expect(src).not.toMatch(/json\(\{[^}]*stk\.responseDescription/s);
  });

  it('money logic is in supabase/functions, not src/', () => {
    // Normalize to forward slashes for cross-platform comparison.
    const normalizedPath = SOURCE_PATH.replace(/\\/g, '/');
    expect(normalizedPath).toContain('supabase/functions/chama-contribute');
    expect(normalizedPath).not.toMatch(/\/src\//);
  });
});

// ── Shared helper imports ──────────────────────────────────────────────────

describe('chama-contribute: shared helper imports', () => {
  it('imports requestDarajaStkPush from _shared/daraja-stk.ts', () => {
    expect(src).toContain("from '../_shared/daraja-stk.ts'");
  });

  it('imports normalizePhone from _shared/payment-lifecycle.ts', () => {
    expect(src).toContain('normalizePhone');
    expect(src).toContain("from '../_shared/payment-lifecycle.ts'");
  });

  it('does NOT import buildPendingPaymentRecord (incompatible with this flow)', () => {
    // The string may appear in a comment explaining exclusion; check import and calls only.
    expect(src).not.toMatch(/import\s*\{[^}]*buildPendingPaymentRecord/);
    expect(src).not.toMatch(/\bbuildPendingPaymentRecord\s*\(/);
  });

  it('does NOT import from other Edge Function directories', () => {
    // Check import statements only — comments may reference sibling functions for context.
    expect(src).not.toMatch(/from\s+['"].*(initiate-payment|webhook-handler|reconciliation-job)['"]/);
  });

  it('imports requireFunctionEnv and serviceNotConfiguredResponse from _shared/function-env.ts', () => {
    expect(src).toContain('requireFunctionEnv');
    expect(src).toContain('serviceNotConfiguredResponse');
    expect(src).toContain("from '../_shared/function-env.ts'");
  });
});
