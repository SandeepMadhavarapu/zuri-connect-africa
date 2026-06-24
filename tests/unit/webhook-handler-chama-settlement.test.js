/**
 * webhook-handler chama settlement branch — structural assertions
 *
 * webhook-handler/index.ts runs under Deno (top-level Deno.serve) and cannot be
 * imported in Vitest/Node, so — exactly like webhook-handler-hardening.test.js
 * and chama-contribute.test.js — these tests read the source as text and assert
 * that the additive chama branch is wired correctly AND that every non-chama
 * payment still reaches finalizeDarajaPayment unchanged.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(
  process.cwd(),
  'supabase/functions/webhook-handler/index.ts',
);
const src = readFileSync(SOURCE_PATH, 'utf8');

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const code = stripComments(src);

// ── The branch exists and is gated on payment_type ─────────────────────────

describe('webhook-handler: chama branch gating', () => {
  it('branches on pending.payment_type === "chama_contribution"', () => {
    expect(code).toMatch(/pending\.payment_type\s*===\s*'chama_contribution'/);
  });

  it('the chama branch is the only payment_type gate (additive, single branch)', () => {
    const matches = (code.match(/payment_type\s*===\s*'chama_contribution'/g) ?? []).length;
    expect(matches).toBe(1);
  });
});

// ── Chama SUCCESS callback routes to the RPC, not finalizeDarajaPayment ─────

describe('webhook-handler: chama success → settle_chama_contribution RPC', () => {
  it('calls the settle_chama_contribution RPC', () => {
    expect(code).toMatch(/\.rpc\(\s*\n?\s*'settle_chama_contribution'/);
  });

  it('passes the documented RPC params (p_tx_ref, p_receipt, p_settled_at, p_payload_hash)', () => {
    expect(code).toMatch(/p_tx_ref:\s*pending\.tx_ref/);
    expect(code).toMatch(/p_receipt:\s*callback\.receiptNumber/);
    expect(code).toMatch(/p_settled_at:\s*new Date\(\)\.toISOString\(\)/);
    expect(code).toMatch(/p_payload_hash:\s*payloadHash/);
  });

  it('only calls the RPC on a SUCCESS callback (gated by callbackStatus === succeeded)', () => {
    const branchIdx = code.indexOf("payment_type === 'chama_contribution'");
    const successGateIdx = code.indexOf("chamaStatus === 'succeeded'", branchIdx);
    const rpcIdx = code.indexOf("'settle_chama_contribution'", branchIdx);
    expect(successGateIdx).toBeGreaterThan(branchIdx);
    expect(rpcIdx).toBeGreaterThan(successGateIdx);
  });

  it('a successful RPC result (ok:true) responds success and never marks review/failed', () => {
    expect(code).toMatch(/r\.ok\s*===\s*true/);
    expect(code).toMatch(/status:\s*'succeeded'/);
  });
});

// ── Non-chama callbacks still reach finalizeDarajaPayment, unchanged ────────

describe('webhook-handler: non-chama still routes to finalizeDarajaPayment', () => {
  it('still calls finalizeDarajaPayment', () => {
    expect(code).toMatch(/await finalizeDarajaPayment\(\{/);
  });

  it('the chama branch RETURNS before finalizeDarajaPayment (non-chama falls through)', () => {
    const branchIdx = code.indexOf("payment_type === 'chama_contribution'");
    const finalizeIdx = code.indexOf('await finalizeDarajaPayment({');
    expect(branchIdx).toBeGreaterThan(-1);
    expect(finalizeIdx).toBeGreaterThan(branchIdx);
    // The chama block must end (close brace + return) before finalizeDarajaPayment.
    const chamaBlock = code.slice(branchIdx, finalizeIdx);
    expect(chamaBlock).toMatch(/return json\(/);
  });

  it('settle_chama_contribution is NOT called on the finalizeDarajaPayment path', () => {
    // The only RPC reference must sit inside the chama branch (before finalize).
    const rpcIdx = code.indexOf("'settle_chama_contribution'");
    const finalizeIdx = code.indexOf('await finalizeDarajaPayment({');
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeLessThan(finalizeIdx);
  });

  it('does not modify the finalizeDarajaPayment call site (same shared deps)', () => {
    expect(code).toMatch(/finalizeDarajaPayment\(\{[\s\S]*?callback,[\s\S]*?pending,[\s\S]*?payloadHash/);
    expect(code).toMatch(/getLatestBalance,/);
    expect(code).toMatch(/postDoubleEntry,/);
  });
});

// ── AMOUNT_MISMATCH → review_required, never succeeded ──────────────────────

describe('webhook-handler: chama AMOUNT_MISMATCH → review_required', () => {
  it('detects AMOUNT_MISMATCH from the RPC result', () => {
    expect(code).toMatch(/r\.error\s*===\s*'AMOUNT_MISMATCH'/);
  });

  it('the ok:false path sets pending to review_required (holdForReview), not succeeded', () => {
    expect(code).toMatch(/holdForReview\(/);
    expect(code).toMatch(/status:\s*'review_required'/);
    // The review path must respond with reviewRequired and NOT status:'succeeded'.
    const branchIdx = code.indexOf("payment_type === 'chama_contribution'");
    const finalizeIdx = code.indexOf('await finalizeDarajaPayment({');
    const chamaBlock = code.slice(branchIdx, finalizeIdx);
    expect(chamaBlock).toMatch(/reviewRequired:\s*true/);
  });

  it('holdForReview mirrors the non-chama review path: review_required + manual-review event, no ledger', () => {
    const hfrIdx = code.indexOf('holdForReview = async');
    const block = code.slice(hfrIdx, hfrIdx + 1400);
    expect(block).toMatch(/updatePendingPayment\(pending\.id,\s*\{[\s\S]*?status:\s*'review_required'/);
    expect(block).toMatch(/requires_manual_review:\s*true/);
    expect(block).not.toMatch(/postDoubleEntry/);
    expect(block).not.toMatch(/ledger_posted_at/);
    // Never marks the pending row succeeded on a review.
    expect(block).not.toMatch(/status:\s*'succeeded'/);
  });
});

// ── LEDGER_POST_FAILED → review_required, never succeeded ───────────────────

describe('webhook-handler: chama LEDGER_POST_FAILED → review_required', () => {
  it('non-AMOUNT_MISMATCH ok:false (e.g. LEDGER_POST_FAILED) also routes to review (ledger_post_failed event)', () => {
    expect(code).toMatch(/'amount_mismatch'\s*:\s*'ledger_post_failed'/);
  });

  it('an RPC transport error also holds for review and never marks succeeded (500)', () => {
    const errMatch = code.match(/if\s*\(\s*rpcError\s*\)\s*\{[\s\S]*?\}/);
    expect(errMatch).not.toBeNull();
    expect(code).toMatch(/CHAMA_SETTLEMENT_FAILED/);
    const block = errMatch[0];
    expect(block).toMatch(/holdForReview\(/);
    expect(block).not.toMatch(/status:\s*'succeeded'/);
  });
});

// ── FAILED callback (ResultCode != 0) → pending failed + obligation reset ───

describe('webhook-handler: chama FAILED callback resets the obligation, no RPC', () => {
  it('the failure path (else of the success gate) marks the pending row to the terminal status', () => {
    const branchIdx = code.indexOf("payment_type === 'chama_contribution'");
    const finalizeIdx = code.indexOf('await finalizeDarajaPayment({');
    const chamaBlock = code.slice(branchIdx, finalizeIdx);
    expect(chamaBlock).toMatch(/updatePendingPayment\(pending\.id,\s*\{[\s\S]*?status:\s*chamaStatus/);
  });

  it('resets the obligation to due / payment_tx_ref=null guarded on pending_payment', () => {
    expect(code).toMatch(/\.from\('chama_obligations'\)/);
    expect(code).toMatch(/status:\s*'due',\s*payment_tx_ref:\s*null/);
    expect(code).toMatch(/\.eq\('payment_tx_ref',\s*pending\.tx_ref\)/);
    expect(code).toMatch(/\.eq\('status',\s*'pending_payment'\)/);
  });

  it('does NOT call the settlement RPC on the failure path (RPC sits inside the success gate only)', () => {
    // The settlement RPC must be INVOKED exactly once. Count the actual call
    // pattern `.rpc('settle_chama_contribution'` — NOT the bare name, which also
    // appears in two holdForReview() reason strings (e.g. "settle_chama_contribution
    // returned ...") that are not invocations.
    const rpcInvocations = (code.match(/\.rpc\(\s*'settle_chama_contribution'/g) ?? []).length;
    expect(rpcInvocations).toBe(1);

    // That single invocation appears after the success gate opens...
    const successGateIdx = code.indexOf("chamaStatus === 'succeeded'");
    const rpcIdx = code.search(/\.rpc\(\s*'settle_chama_contribution'/);
    expect(successGateIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(successGateIdx);

    // ...and the failure branch — the region of the source after the success
    // gate closes (the obligation-reset path that is reached ONLY when the
    // callback is not 'succeeded', through the end of the chama branch) —
    // contains NO `.rpc(` invocation at all.
    const failureBranchIdx = code.indexOf("from('chama_obligations')");
    const finalizeIdx = code.indexOf('await finalizeDarajaPayment({');
    expect(failureBranchIdx).toBeGreaterThan(rpcIdx);
    expect(finalizeIdx).toBeGreaterThan(failureBranchIdx);
    const failureBranch = code.slice(failureBranchIdx, finalizeIdx);
    expect(failureBranch).not.toMatch(/\.rpc\(/);
  });
});

// ── Duplicate callback de-dup is shared (runs before the branch) ────────────

describe('webhook-handler: chama duplicates caught by shared webhook_events de-dup', () => {
  it('the existing-event de-dup + webhook_events insert run before findPendingPayment resolves the branch', () => {
    const dedupIdx = code.indexOf('existingEvent');
    const resolveIdx = code.lastIndexOf('findPendingPayment(supabaseAdmin, callback.checkoutRequestId, callback.merchantRequestId, callback.accountReference)');
    const branchIdx = code.indexOf("payment_type === 'chama_contribution'");
    expect(dedupIdx).toBeGreaterThan(-1);
    expect(dedupIdx).toBeLessThan(resolveIdx);
    expect(resolveIdx).toBeLessThan(branchIdx);
  });

  it('shared security checks (IP, HMAC, nonce) are untouched and precede the branch', () => {
    const branchIdx = code.indexOf("payment_type === 'chama_contribution'");
    expect(code.indexOf('isAllowedSafaricomIp')).toBeLessThan(branchIdx);
    expect(code.indexOf('verifyWebhookSignature')).toBeLessThan(branchIdx);
    expect(code.indexOf('checkAndRecordNonce')).toBeLessThan(branchIdx);
  });
});

// ── No new ledger writes leak into the chama branch (RPC owns the ledger) ───

describe('webhook-handler: chama branch never posts the ledger directly', () => {
  it('the chama branch does not call post_double_entry or insert ledger_entries', () => {
    const branchIdx = code.indexOf("payment_type === 'chama_contribution'");
    const finalizeIdx = code.indexOf('await finalizeDarajaPayment({');
    const chamaBlock = code.slice(branchIdx, finalizeIdx);
    expect(chamaBlock).not.toMatch(/postDoubleEntry/);
    expect(chamaBlock).not.toMatch(/post_double_entry/);
    expect(chamaBlock).not.toMatch(/\.from\('ledger_entries'\)/);
  });
});
