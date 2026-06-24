import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildPendingPaymentRecord,
  buildLedgerRpcArgs,
  finalizeDarajaPayment,
  parseDarajaStkCallback,
} from '../../supabase/functions/_shared/payment-lifecycle.ts';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260518090000_server_authoritative_ledger.sql'),
  'utf8'
);
const lifecycleMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260518140000_mpesa_payment_lifecycle_hardening.sql'),
  'utf8'
);
const initiatePaymentFunction = readFileSync(
  resolve(process.cwd(), 'supabase/functions/initiate-payment/index.ts'),
  'utf8'
);

function successCallback() {
  return parseDarajaStkCallback({
    Body: {
      stkCallback: {
        MerchantRequestID: 'm-1',
        CheckoutRequestID: 'checkout-1',
        ResultCode: 0,
        ResultDesc: 'The service request is processed successfully.',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 100 },
            { Name: 'MpesaReceiptNumber', Value: 'RCP123' },
            { Name: 'PhoneNumber', Value: 254712345678 },
          ],
        },
      },
    },
  });
}

describe('server-authoritative ledger migration', () => {
  it('prevents authenticated users inserting ledger_entries directly', () => {
    expect(migration).toMatch(/REVOKE INSERT, UPDATE, DELETE ON public\.ledger_entries FROM anon, authenticated/i);
    expect(migration).not.toMatch(/ledger_entries.*FOR INSERT[\s\S]*TO authenticated/i);
  });

  it('prevents authenticated users executing post_double_entry', () => {
    expect(migration).toMatch(/REVOKE EXECUTE ON FUNCTION public\.post_double_entry\(JSONB, JSONB, NUMERIC\) FROM PUBLIC, anon, authenticated/i);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.post_double_entry\(JSONB, JSONB, NUMERIC\) TO service_role/i);
  });
});

describe('M-PESA lifecycle hardening migration', () => {
  it('adds reconciliation events for callback review and duplicate evidence', () => {
    expect(lifecycleMigration).toMatch(/CREATE TABLE IF NOT EXISTS public\.payment_reconciliation_events/i);
    expect(lifecycleMigration).toMatch(/requires_manual_review BOOLEAN NOT NULL DEFAULT FALSE/i);
    expect(lifecycleMigration).toMatch(/ALTER TABLE public\.payment_reconciliation_events FORCE ROW LEVEL SECURITY/i);
  });

  it('initiate-payment idempotency returns an existing pending payment instead of creating duplicates', () => {
    expect(initiatePaymentFunction).toMatch(/\.eq\('idempotency_key', pendingRecord\.idempotency_key\)/);
    expect(initiatePaymentFunction).toMatch(/pendingErr\.code === '23505'/);
    expect(initiatePaymentFunction).toMatch(/return json\(pendingResponse\(raced, true\)\)/);
  });
});

describe('payment lifecycle helpers', () => {
  it('initiate-payment builds a pending payment and does not post ledger', () => {
    const pending = buildPendingPaymentRecord({
      userId: 'user-1',
      normalizedFromPhone: '254712345678',
      body: {
        tx_ref: 'TX-1',
        idempotency_key: 'idem-1',
        payment_type: 'send',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
      },
    });

    expect(pending).toMatchObject({
      tx_ref: 'TX-1',
      user_id: 'user-1',
      status: 'processing',
      amount: 100,
    });
    expect(pending).not.toHaveProperty('ledger_posted_at');
  });

  it('rejects a fractional KES amount at intake (LOW-5)', () => {
    // M-Pesa moves only whole KES and the STK push sends Math.ceil(amount), so a
    // fractional stored amount can never equal the integer callback Amount. Reject
    // at intake instead of dead-ending the payment in review_required.
    expect(() => buildPendingPaymentRecord({
      userId: 'user-1',
      normalizedFromPhone: '254712345678',
      body: {
        tx_ref: 'TX-FRAC',
        idempotency_key: 'idem-frac',
        payment_type: 'send',
        amount: 100.5,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
      },
    })).toThrow('AMOUNT_NOT_INTEGER');
  });

  it('integer amount is stored == STK Amount == callback Amount (LOW-5)', () => {
    const pending = buildPendingPaymentRecord({
      userId: 'user-1',
      normalizedFromPhone: '254712345678',
      body: {
        tx_ref: 'TX-INT',
        idempotency_key: 'idem-int',
        payment_type: 'send',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
      },
    });
    // daraja-stk.ts sends Math.ceil(amount); for an integer that equals the stored
    // amount, which is exactly what M-Pesa echoes back in the callback Amount, so
    // the amount-match check can never spuriously fail.
    expect(Number.isInteger(pending.amount)).toBe(true);
    expect(Math.ceil(pending.amount)).toBe(pending.amount);
  });

  it('webhook success posts exactly one debit and one credit', async () => {
    const postDoubleEntry = vi.fn().mockResolvedValue({ ok: true });
    const updatePendingPayment = vi.fn().mockResolvedValue({ ok: true });
    const recordReconciliationEvent = vi.fn().mockResolvedValue({ ok: true });
    const writeAuditEvent = vi.fn().mockResolvedValue({ ok: true });

    const result = await finalizeDarajaPayment({
      callback: successCallback(),
      payloadHash: 'hash-1',
      pending: {
        id: 'pending-1',
        tx_ref: 'TX-1',
        user_id: 'user-1',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
        status: 'processing',
      },
      getLatestBalance: async (phone) => phone === '+254712345678' ? 500 : 25,
      postDoubleEntry,
      updatePendingPayment,
      recordReconciliationEvent,
      writeAuditEvent,
      now: () => '2026-05-18T09:00:00.000Z',
    });

    expect(result.ledgerPosted).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(postDoubleEntry).toHaveBeenCalledTimes(1);
    const args = postDoubleEntry.mock.calls[0][0];
    expect(args.p_debit).toMatchObject({
      transaction_ref: 'TX-1',
      amount: '100',
      balance_before: '500',
      balance_after: '400',
      account_phone: '+254712345678',
    });
    expect(args.p_credit).toMatchObject({
      transaction_ref: 'TX-1',
      amount: '100',
      balance_before: '25',
      balance_after: '125',
      account_phone: '+254723456789',
    });
    expect(updatePendingPayment).toHaveBeenCalledWith('pending-1', expect.objectContaining({ status: 'succeeded' }));
    expect(recordReconciliationEvent).toHaveBeenCalledWith(expect.objectContaining({
      provider_status: 'succeeded',
      amount_match: true,
      phone_match: true,
      requires_manual_review: false,
    }));
    expect(writeAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'payment.webhook.succeeded' }));
  });

  it('duplicate webhook callback does not double-post ledger', async () => {
    const postDoubleEntry = vi.fn();
    const updatePendingPayment = vi.fn();
    const recordReconciliationEvent = vi.fn();
    const result = await finalizeDarajaPayment({
      callback: successCallback(),
      payloadHash: 'hash-1',
      pending: {
        id: 'pending-1',
        tx_ref: 'TX-1',
        user_id: 'user-1',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
        status: 'succeeded',
        ledger_posted_at: '2026-05-18T09:00:00.000Z',
      },
      getLatestBalance: vi.fn(),
      postDoubleEntry,
      updatePendingPayment,
      recordReconciliationEvent,
    });

    expect(result.duplicate).toBe(true);
    expect(postDoubleEntry).not.toHaveBeenCalled();
    expect(updatePendingPayment).not.toHaveBeenCalled();
    expect(recordReconciliationEvent).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'duplicate_success' }));
  });

  it('failed or cancelled callback does not post ledger', async () => {
    const postDoubleEntry = vi.fn();
    const updatePendingPayment = vi.fn().mockResolvedValue({ ok: true });
    const result = await finalizeDarajaPayment({
      callback: {
        checkoutRequestId: 'checkout-1',
        merchantRequestId: 'm-1',
        resultCode: '1032',
        resultDesc: 'Request cancelled by user',
        receiptNumber: null,
        amount: null,
        phoneNumber: null,
      },
      payloadHash: 'hash-2',
      pending: {
        id: 'pending-1',
        tx_ref: 'TX-1',
        user_id: 'user-1',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
        status: 'processing',
      },
      getLatestBalance: vi.fn(),
      postDoubleEntry,
      updatePendingPayment,
    });

    expect(result.status).toBe('cancelled');
    expect(result.ledgerPosted).toBe(false);
    expect(postDoubleEntry).not.toHaveBeenCalled();
    expect(updatePendingPayment).toHaveBeenCalledWith('pending-1', expect.objectContaining({ status: 'cancelled' }));
  });

  it('amount mismatch triggers manual review and does not post ledger', async () => {
    const postDoubleEntry = vi.fn();
    const updatePendingPayment = vi.fn().mockResolvedValue({ ok: true });
    const recordReconciliationEvent = vi.fn().mockResolvedValue({ ok: true });
    const result = await finalizeDarajaPayment({
      callback: {
        ...successCallback(),
        amount: 999,
      },
      payloadHash: 'hash-amount-mismatch',
      pending: {
        id: 'pending-1',
        tx_ref: 'TX-1',
        user_id: 'user-1',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
        status: 'processing',
      },
      getLatestBalance: vi.fn(),
      postDoubleEntry,
      updatePendingPayment,
      recordReconciliationEvent,
    });

    expect(result.reviewRequired).toBe(true);
    expect(result.status).toBe('review_required');
    expect(postDoubleEntry).not.toHaveBeenCalled();
    expect(updatePendingPayment).toHaveBeenCalledWith('pending-1', expect.objectContaining({ status: 'review_required' }));
    expect(recordReconciliationEvent).toHaveBeenCalledWith(expect.objectContaining({
      amount_match: false,
      phone_match: true,
      requires_manual_review: true,
    }));
  });

  it('phone mismatch triggers manual review and does not post ledger', async () => {
    const postDoubleEntry = vi.fn();
    const updatePendingPayment = vi.fn().mockResolvedValue({ ok: true });
    const recordReconciliationEvent = vi.fn().mockResolvedValue({ ok: true });
    const result = await finalizeDarajaPayment({
      callback: {
        ...successCallback(),
        phoneNumber: '254700000000',
      },
      payloadHash: 'hash-phone-mismatch',
      pending: {
        id: 'pending-1',
        tx_ref: 'TX-1',
        user_id: 'user-1',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
        status: 'processing',
      },
      getLatestBalance: vi.fn(),
      postDoubleEntry,
      updatePendingPayment,
      recordReconciliationEvent,
    });

    expect(result.reviewRequired).toBe(true);
    expect(postDoubleEntry).not.toHaveBeenCalled();
    expect(recordReconciliationEvent).toHaveBeenCalledWith(expect.objectContaining({
      amount_match: true,
      phone_match: false,
      requires_manual_review: true,
    }));
  });

  it('late conflicting callback triggers manual review instead of posting ledger', async () => {
    const postDoubleEntry = vi.fn();
    const updatePendingPayment = vi.fn().mockResolvedValue({ ok: true });
    const recordReconciliationEvent = vi.fn().mockResolvedValue({ ok: true });
    const result = await finalizeDarajaPayment({
      callback: successCallback(),
      payloadHash: 'hash-late-success',
      pending: {
        id: 'pending-1',
        tx_ref: 'TX-1',
        user_id: 'user-1',
        amount: 100,
        from_phone: '+254712345678',
        to_phone: '+254723456789',
        status: 'failed',
      },
      getLatestBalance: vi.fn(),
      postDoubleEntry,
      updatePendingPayment,
      recordReconciliationEvent,
    });

    expect(result.reviewRequired).toBe(true);
    expect(result.status).toBe('review_required');
    expect(postDoubleEntry).not.toHaveBeenCalled();
    expect(updatePendingPayment).toHaveBeenCalledWith('pending-1', expect.objectContaining({ status: 'review_required' }));
    expect(recordReconciliationEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'conflicting_provider_status',
      requires_manual_review: true,
    }));
  });

  it('buildLedgerRpcArgs can reverse Fuliza drawdown direction server-side', async () => {
    const args = await buildLedgerRpcArgs({
      id: 'pending-2',
      tx_ref: 'TX-FULIZA',
      user_id: 'user-1',
      payment_type: 'fuliza_drawdown',
      amount: 50,
      from_phone: '+254712345678',
      to_phone: 'FULIZA-ENGINE',
      status: 'processing',
    }, 1000, 10);

    expect(args.p_debit.account_phone).toBe('FULIZA-ENGINE');
    expect(args.p_credit.account_phone).toBe('+254712345678');
  });
});
