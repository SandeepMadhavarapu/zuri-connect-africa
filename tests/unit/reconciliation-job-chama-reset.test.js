/**
 * reconciliation-job chama obligation reset sweep — structural assertions
 *
 * reconciliation-job/index.ts runs under Deno (top-level Deno.serve) and cannot
 * be imported in Vitest/Node, so — like webhook-handler-hardening.test.js — these
 * tests read the source as text and assert that the additive §4-B obligation
 * reset sweep is wired correctly AND that the existing sweepStuckPendingPayments
 * call is left intact.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(
  process.cwd(),
  'supabase/functions/reconciliation-job/index.ts',
);
const src = readFileSync(SOURCE_PATH, 'utf8');

function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const code = stripComments(src);

// ── Existing sweep is preserved ─────────────────────────────────────────────

describe('reconciliation-job: existing stuck-payment sweep is unaltered', () => {
  it('still calls sweepStuckPendingPayments', () => {
    expect(code).toMatch(/await sweepStuckPendingPayments\(/);
  });

  it('still imports sweepStuckPendingPayments from _shared/stuck-payments.ts', () => {
    expect(src).toMatch(/from '\.\.\/_shared\/stuck-payments\.ts'/);
  });

  it('still queries only processing/waiting_for_mpesa in the stuck fetch', () => {
    expect(code).toMatch(/in\('status',\s*\['processing',\s*'waiting_for_mpesa'\]\)/);
  });

  it('still wires the provider-query sweep + ledger reconciliation RPC', () => {
    expect(code).toMatch(/runProviderQuerySweep/);
    expect(code).toMatch(/run_reconciliation/);
  });
});

// ── The reset sweep runs AFTER the existing sweep ───────────────────────────

describe('reconciliation-job: obligation reset runs after sweepStuckPendingPayments', () => {
  it('calls resetStuckChamaObligations after sweepStuckPendingPayments', () => {
    const sweepIdx = code.indexOf('await sweepStuckPendingPayments(');
    const resetIdx = code.indexOf('await resetStuckChamaObligations(');
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(resetIdx).toBeGreaterThan(sweepIdx);
  });

  it('returns the reset summary in the response (chama_obligation_reset)', () => {
    expect(code).toMatch(/chama_obligation_reset:\s*chamaObligationReset/);
  });
});

// ── The reset sweep logic (§4-B) ────────────────────────────────────────────

describe('reconciliation-job: chama obligation reset sweep logic', () => {
  it('selects obligations stuck in pending_payment with a linked tx_ref', () => {
    expect(code).toMatch(/\.from\('chama_obligations'\)/);
    expect(code).toMatch(/\.eq\('status',\s*'pending_payment'\)/);
    expect(code).toMatch(/\.not\('payment_tx_ref',\s*'is',\s*null\)/);
  });

  it('matches linked pending rows in a TERMINAL FAILURE state only', () => {
    expect(code).toMatch(/\.from\('pending_payments'\)/);
    expect(code).toMatch(/\.in\('status',\s*\['failed',\s*'cancelled',\s*'timeout'\]\)/);
  });

  it('does NOT reset obligations whose pending row is review_required', () => {
    // review_required must never appear in the failure-status filter for the
    // reset sweep. Guard against accidental inclusion.
    const resetIdx = code.indexOf('async function resetStuckChamaObligations');
    const block = code.slice(resetIdx);
    expect(block).not.toMatch(/'review_required'/);
  });

  it('resets matched obligations to due / payment_tx_ref=null, idempotently guarded', () => {
    expect(code).toMatch(/status:\s*'due',\s*payment_tx_ref:\s*null/);
    // Idempotent guard: the UPDATE must re-assert status='pending_payment'.
    const resetIdx = code.indexOf('async function resetStuckChamaObligations');
    const block = code.slice(resetIdx);
    expect(block).toMatch(/\.update\(\{\s*status:\s*'due',\s*payment_tx_ref:\s*null[\s\S]*?\.eq\('status',\s*'pending_payment'\)/);
  });

  it('never posts to the ledger from the reset sweep', () => {
    const resetIdx = code.indexOf('async function resetStuckChamaObligations');
    const block = code.slice(resetIdx);
    expect(block).not.toMatch(/post_double_entry/);
    expect(block).not.toMatch(/postDoubleEntry/);
    expect(block).not.toMatch(/\.from\('ledger_entries'\)/);
  });

  it('logs a structured summary with scanned + reset counts (no secrets)', () => {
    expect(code).toMatch(/evt:\s*'chama_obligation_reset_sweep'/);
    expect(code).toMatch(/scanned:\s*summary\.scanned/);
    expect(code).toMatch(/reset:\s*summary\.reset/);
  });
});
