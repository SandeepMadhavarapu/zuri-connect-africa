import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invokeEdgeFunction: vi.fn(),
  getSession: vi.fn(),
  maybeSingle: vi.fn(),
}));

vi.mock('@/api/client.js', () => ({
  invokeEdgeFunction: mocks.invokeEdgeFunction,
}));

vi.mock('@/lib/ledger.js', () => ({
  generateTxRef: vi.fn(() => 'TX-FRONTEND'),
}));

vi.mock('@/lib/clientLedgerGuard.js', () => ({
  isClientDemoLedgerAllowed: vi.fn(() => false),
}));

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: { getSession: mocks.getSession },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: mocks.maybeSingle,
    })),
  })),
}));

describe('frontend payment service hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt-1' } },
      error: null,
    });
  });

  it('never marks payment succeeded from initiate-payment response alone', async () => {
    const { initiateServerPayment } = await import('@/services/paymentService.js');
    mocks.invokeEdgeFunction.mockResolvedValue({
      ok: true,
      pending_payment_id: 'pending-1',
      tx_ref: 'TX-FRONTEND',
      status: 'succeeded',
    });

    const result = await initiateServerPayment({
      type: 'send',
      fromPhone: '+254712345678',
      toPhone: '+254723456789',
      amount: 100,
      userId: 'user-1',
      idempotencyKey: 'idem-1',
    });

    expect(result).toMatchObject({
      pending_payment_id: 'pending-1',
      tx_ref: 'TX-FRONTEND',
      status: 'processing',
    });
  });

  it('only treats succeeded pending_payments status as final success', async () => {
    const { waitForPaymentConfirmation } = await import('@/services/paymentService.js');
    mocks.maybeSingle
      .mockResolvedValueOnce({ data: { id: 'pending-1', status: 'waiting_for_mpesa' }, error: null })
      .mockResolvedValueOnce({ data: { id: 'pending-1', status: 'succeeded' }, error: null });

    const statuses = [];
    const result = await waitForPaymentConfirmation(
      { pending_payment_id: 'pending-1', status: 'processing' },
      {
        intervalMs: 1,
        timeoutMs: 50,
        onStatus: (row) => statuses.push(row.status),
      }
    );

    expect(result.status).toBe('succeeded');
    expect(statuses).toEqual(['processing', 'waiting_for_mpesa', 'succeeded']);
  });

  it('review_required does not become frontend success', async () => {
    const { waitForPaymentConfirmation } = await import('@/services/paymentService.js');
    mocks.maybeSingle.mockResolvedValueOnce({
      data: { id: 'pending-1', status: 'review_required', result_desc: 'Manual reconciliation required' },
      error: null,
    });

    await expect(waitForPaymentConfirmation(
      { pending_payment_id: 'pending-1', status: 'processing' },
      { intervalMs: 1, timeoutMs: 50 }
    )).rejects.toThrow(/Manual reconciliation required/);
  });

  it('surfaces step-up required without treating it as success', async () => {
    const { initiateServerPayment } = await import('@/services/paymentService.js');
    mocks.invokeEdgeFunction.mockResolvedValue({
      ok: false,
      error: 'RISK_STEP_UP_REQUIRED',
      pending_payment_id: 'pending-2',
      tx_ref: 'TX-STEP',
      required_step_up: 'pin',
      step_up_challenge_id: 'challenge-2',
      message: 'internal threshold detail',
    });

    const result = await initiateServerPayment({
      type: 'send',
      fromPhone: '+254712345678',
      toPhone: '+254723456789',
      amount: 60000,
      userId: 'user-1',
      idempotencyKey: 'idem-step-up-2',
    });

    expect(result.stepUpRequired).toBe(true);
    expect(result.status).toBe('step_up_required');
    expect(result.message).toBe('We need one more verification step.');
  });

  it('maps server risk decisions to safe user-facing messages', async () => {
    const { initiateServerPayment } = await import('@/services/paymentService.js');
    mocks.invokeEdgeFunction.mockResolvedValue({
      ok: false,
      error: 'RISK_BLOCKED',
      status: 'blocked',
      message: 'internal details should not be exposed',
    });

    await expect(initiateServerPayment({
      type: 'send',
      fromPhone: '+254712345678',
      toPhone: '+254723456789',
      amount: 100,
      userId: 'user-1',
      idempotencyKey: 'idem-risk-blocked',
    })).rejects.toThrow('For your safety, this action was blocked.');
  });
});
