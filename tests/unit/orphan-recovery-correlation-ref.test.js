/**
 * MED-3 — debited-but-unmatchable orphan recovery.
 *
 * Covers the three behaviours the fix promises:
 *   (a) the STK push carries AccountReference = the pending row's server-generated
 *       correlation_ref (set BEFORE the network call);
 *   (b) findPendingPaymentByCallback re-links a callback by the echoed
 *       AccountReference (correlation_ref) when checkout_request_id is NULL, while
 *       leaving the happy path (checkout_request_id match) byte-for-byte unchanged;
 *   (c) reconciliation no longer silently times out NULL-checkout_request_id rows —
 *       surfaceUnmatchableOrphans routes them to review with a
 *       webhook.orphan_recovered audit event.
 *
 * Edge-function index.ts files run under Deno (top-level Deno.serve) and cannot be
 * imported in Vitest, so call-site wiring is asserted at the source level (the
 * same pattern as reconciliation-job-chama-reset.test.js / webhook-handler-hardening).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildPendingPaymentRecord,
  generateCorrelationRef,
  parseDarajaStkCallback,
  findPendingPaymentByCallback,
} from '../../supabase/functions/_shared/payment-lifecycle.ts';
import {
  surfaceUnmatchableOrphans,
} from '../../supabase/functions/_shared/stuck-payments.ts';

function readSource(rel) {
  return readFileSync(resolve(process.cwd(), rel), 'utf8');
}
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── (a) STK push carries the correlation key ────────────────────────────────

describe('MED-3 (a): correlation_ref is the STK AccountReference', () => {
  it('generateCorrelationRef is <=12 chars, alphanumeric, and varies', () => {
    const a = generateCorrelationRef();
    const b = generateCorrelationRef();
    expect(a).toMatch(/^[0-9A-Z]{1,12}$/);
    expect(a.length).toBeLessThanOrEqual(12);
    expect(a).not.toBe(b); // CSPRNG — collision is astronomically unlikely
  });

  it('buildPendingPaymentRecord stamps correlation_ref on the row', () => {
    const record = buildPendingPaymentRecord({
      body: {
        tx_ref: 'TX-abc-123', idempotency_key: 'idem-1', payment_type: 'send',
        to_phone: '0712345678', amount: 100,
      },
      userId: 'user-1',
      normalizedFromPhone: '254712345678',
    });
    expect(record.correlation_ref).toMatch(/^[0-9A-Z]{1,12}$/);
    // The user-facing biller account_reference is preserved, NOT overwritten.
    expect(record.metadata.account_reference).toBe('TX-abc-123');
  });

  it('a provided correlationRef can be pinned (deterministic for callers/tests)', () => {
    const record = buildPendingPaymentRecord({
      body: { tx_ref: 'TX', idempotency_key: 'k', payment_type: 'send', to_phone: '0712345678', amount: 10 },
      userId: 'u', normalizedFromPhone: '254712345678',
      correlationRef: 'CORR12345678',
    });
    expect(record.correlation_ref).toBe('CORR12345678');
  });

  it('initiate-payment sends pendingRecord.correlation_ref as AccountReference', () => {
    const src = stripComments(readSource('supabase/functions/initiate-payment/index.ts'));
    expect(src).toMatch(/accountReference:\s*pendingRecord\.correlation_ref/);
    // The persisted record (which includes correlation_ref) is inserted BEFORE the
    // STK call, so the key is durable before any network I/O.
    expect(src).toMatch(/\.insert\(pendingRecord\)/);
  });

  it('chama-contribute sends a generated correlationRef as AccountReference', () => {
    const src = stripComments(readSource('supabase/functions/chama-contribute/index.ts'));
    expect(src).toMatch(/const correlationRef = generateCorrelationRef\(\)/);
    expect(src).toMatch(/correlation_ref:\s*correlationRef/);
    expect(src).toMatch(/accountReference:\s*correlationRef/);
  });

  it('complete-step-up resumes using the row correlation_ref', () => {
    const src = stripComments(readSource('supabase/functions/complete-step-up/index.ts'));
    expect(src).toMatch(/pending\.correlation_ref/);
    expect(src).toMatch(/correlation_ref/); // selected from the row
  });
});

// ── echoed AccountReference extraction ──────────────────────────────────────

describe('MED-3: parseDarajaStkCallback extracts the echoed AccountReference', () => {
  function base(extra) {
    return {
      Body: {
        stkCallback: {
          MerchantRequestID: 'm-1',
          CheckoutRequestID: 'checkout-1',
          ResultCode: 0,
          ResultDesc: 'ok',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 100 },
              { Name: 'MpesaReceiptNumber', Value: 'RCP1' },
              { Name: 'PhoneNumber', Value: 254712345678 },
              ...(extra?.items ?? []),
            ],
          },
          ...(extra?.stk ?? {}),
        },
      },
    };
  }

  it('reads a top-level BillRefNumber', () => {
    const cb = parseDarajaStkCallback(base({ stk: { BillRefNumber: 'CORR12345678' } }));
    expect(cb.accountReference).toBe('CORR12345678');
  });

  it('reads AccountReference from CallbackMetadata items', () => {
    const cb = parseDarajaStkCallback(base({ items: [{ Name: 'AccountReference', Value: 'CORRABC99999' }] }));
    expect(cb.accountReference).toBe('CORRABC99999');
  });

  it('is null when no reference is echoed (does not throw)', () => {
    const cb = parseDarajaStkCallback(base());
    expect(cb.accountReference).toBeNull();
  });
});

// ── (b) findPendingPaymentByCallback ────────────────────────────────────────

describe('MED-3 (b): findPendingPaymentByCallback orphan fallback', () => {
  const ROW = { id: 'p-1', tx_ref: 'TX', user_id: 'u', amount: 100, from_phone: '254700', to_phone: '254711', status: 'processing' };

  function finder({ checkout = null, merchant = null, corr = null, spy }) {
    return {
      byCheckoutRequestId: async (id) => { spy?.push(['checkout', id]); return checkout; },
      byMerchantRequestId: async (id) => { spy?.push(['merchant', id]); return merchant; },
      byCorrelationRef:    async (r)  => { spy?.push(['corr', r]); return corr; },
    };
  }

  it('happy path: checkout_request_id match never consults correlation_ref', async () => {
    const spy = [];
    const result = await findPendingPaymentByCallback(
      finder({ checkout: ROW, spy }),
      { checkoutRequestId: 'checkout-1', merchantRequestId: 'm-1', accountReference: 'CORR12345678' },
    );
    expect(result).toBe(ROW);
    expect(spy).toEqual([['checkout', 'checkout-1']]); // arms 2 and 3 never run
  });

  it('orphan: matches by AccountReference when checkout AND merchant miss', async () => {
    const spy = [];
    const result = await findPendingPaymentByCallback(
      finder({ checkout: null, merchant: null, corr: ROW, spy }),
      { checkoutRequestId: 'checkout-1', merchantRequestId: 'm-1', accountReference: 'CORR12345678' },
    );
    expect(result).toBe(ROW);
    // correlation arm runs ONLY after the first two miss (order preserved).
    expect(spy).toEqual([
      ['checkout', 'checkout-1'],
      ['merchant', 'm-1'],
      ['corr', 'CORR12345678'],
    ]);
  });

  it('returns null when nothing matches (true orphan)', async () => {
    const result = await findPendingPaymentByCallback(
      finder({}),
      { checkoutRequestId: 'c', merchantRequestId: 'm', accountReference: 'CORRZ' },
    );
    expect(result).toBeNull();
  });

  it('does not attempt the correlation arm when no AccountReference was echoed', async () => {
    const spy = [];
    const result = await findPendingPaymentByCallback(
      finder({ spy }),
      { checkoutRequestId: 'c', merchantRequestId: 'm', accountReference: null },
    );
    expect(result).toBeNull();
    expect(spy.find((c) => c[0] === 'corr')).toBeUndefined();
  });
});

// ── (c) reconciliation surfaces orphans instead of timing them out ──────────

describe('MED-3 (c): surfaceUnmatchableOrphans', () => {
  function deps({ rows, markReviewResult = true }) {
    const events = [];
    const audits = [];
    const reviewed = [];
    return {
      spy: { events, audits, reviewed },
      d: {
        fetchOrphans: async () => rows,
        markReview: async (id, patch) => { reviewed.push({ id, patch }); return markReviewResult; },
        recordEvent: async (e) => { events.push(e); },
        writeAuditEvent: async (e) => { audits.push(e); },
        now: () => new Date('2026-06-24T12:00:00Z'),
      },
    };
  }

  const orphanRow = {
    id: 'p-1', tx_ref: 'TX-1', status: 'processing', amount: 250,
    from_phone: '254700', to_phone: '254711',
    checkout_request_id: null, correlation_ref: 'CORR12345678',
    updated_at: '2026-06-24T11:00:00Z',
  };

  it('surfaces a NULL-checkout orphan to review_required, never timeout', async () => {
    const { spy, d } = deps({ rows: [orphanRow] });
    const report = await surfaceUnmatchableOrphans(d, { stuckAfterMinutes: 30 });

    expect(report).toEqual({ scanned: 1, surfacedForReview: 1, racedOrAlreadyMoved: 0 });
    // It moves the row to review_required (NOT 'timeout').
    expect(spy.reviewed[0].patch.status).toBe('review_required');
    expect(spy.reviewed.some((r) => r.patch.status === 'timeout')).toBe(false);
    // It records a manual-review reconciliation event...
    expect(spy.events[0].event_type).toBe('orphan_recovery_required');
    expect(spy.events[0].requires_manual_review).toBe(true);
    // ...and a critical webhook.orphan_recovered audit event.
    expect(spy.audits[0].event_type).toBe('webhook.orphan_recovered');
    expect(spy.audits[0].severity).toBe('critical');
    expect(spy.audits[0].payload.correlation_ref).toBe('CORR12345678');
  });

  it('counts a row as raced (not surfaced) when the guarded update moves 0 rows', async () => {
    const { spy, d } = deps({ rows: [orphanRow], markReviewResult: false });
    const report = await surfaceUnmatchableOrphans(d, { stuckAfterMinutes: 30 });
    expect(report).toEqual({ scanned: 1, surfacedForReview: 0, racedOrAlreadyMoved: 1 });
    // No review/audit events for a row a callback already re-linked.
    expect(spy.events.length).toBe(0);
    expect(spy.audits.length).toBe(0);
  });

  it('never touches an already-terminal row', async () => {
    const { spy, d } = deps({ rows: [{ ...orphanRow, status: 'succeeded' }] });
    const report = await surfaceUnmatchableOrphans(d, { stuckAfterMinutes: 30 });
    expect(report.surfacedForReview).toBe(0);
    expect(report.racedOrAlreadyMoved).toBe(1);
    expect(spy.reviewed.length).toBe(0);
  });
});

describe('MED-3 (c): reconciliation-job wiring', () => {
  const src = stripComments(readSource('supabase/functions/reconciliation-job/index.ts'));

  it('runs surfaceUnmatchableOrphans BEFORE sweepStuckPendingPayments', () => {
    const orphanIdx = src.indexOf('await surfaceUnmatchableOrphans(');
    const sweepIdx = src.indexOf('await sweepStuckPendingPayments(');
    expect(orphanIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeGreaterThan(-1);
    expect(orphanIdx).toBeLessThan(sweepIdx);
  });

  it('fetches only NULL-checkout_request_id rows for the orphan sweep', () => {
    expect(src).toMatch(/\.is\('checkout_request_id',\s*null\)/);
  });

  it('returns the orphan report in the response (unmatchable_orphans)', () => {
    expect(src).toMatch(/unmatchable_orphans:\s*orphanReport/);
  });
});
