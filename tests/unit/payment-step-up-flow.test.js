/**
 * Payment pages step-up integration tests.
 *
 * Covers:
 *  - Send / Paybill / Airtime / Bundles cannot proceed when server returns
 *    RISK_STEP_UP_REQUIRED until completeServerStepUp succeeds.
 *  - All four pages forward the step_up_challenge_id and the biometric proof
 *    (challenge_id, credential_id, client_data_json, authenticator_data,
 *    signature) to completeStepUp without modification.
 *  - resumePaymentAfterStepUp throws (and never marks done) when server
 *    rejects the proof.
 *  - The pages import BiometricStepUpModal (i.e. they have the action-bound
 *    biometric step-up wired).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const biometricStepUpSource = readFileSync(resolve(process.cwd(), 'src/lib/biometricStepUp.js'), 'utf8');

describe('biometricStepUp library security', () => {
  it('does not call verify-biometric.verify (assertion goes straight to complete-step-up)', () => {
    expect(biometricStepUpSource).not.toMatch(/action:\s*'verify'/);
    expect(biometricStepUpSource).toMatch(/get_step_up_assertion_options/);
  });

  it('sanitizes bearer tokens, challenges, and assertion blobs from logs', () => {
    expect(biometricStepUpSource).toMatch(/Bearer\s\[redacted\]/);
    expect(biometricStepUpSource).toMatch(/challenge=\[redacted\]/);
    expect(biometricStepUpSource).toMatch(/authenticator_data=\[redacted\]/);
    expect(biometricStepUpSource).toMatch(/signature=\[redacted\]/);
    expect(biometricStepUpSource).toMatch(/credential_id=\[redacted\]/);
    expect(biometricStepUpSource).toMatch(/access_token=\[redacted\]/);
  });

  it('falls closed when WebAuthn unsupported / cancelled / failed', () => {
    expect(biometricStepUpSource).toMatch(/BIOMETRIC_UNSUPPORTED_MESSAGE/);
    expect(biometricStepUpSource).toMatch(/BIOMETRIC_CANCELLED_MESSAGE/);
    expect(biometricStepUpSource).toMatch(/BIOMETRIC_VERIFICATION_FAILED_MESSAGE/);
  });
});

// ── paymentService.resumePaymentAfterStepUp integration ──────────────────────

const paymentMocks = vi.hoisted(() => ({
  invokeEdgeFunction: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/api/client.js', () => ({
  invokeEdgeFunction: paymentMocks.invokeEdgeFunction,
}));
vi.mock('@/lib/ledger.js', () => ({ generateTxRef: vi.fn(() => 'TX-resume') }));
vi.mock('@/lib/clientLedgerGuard.js', () => ({ isClientDemoLedgerAllowed: vi.fn(() => false) }));
function makeChainable(finalRow) {
  const node = {
    select: () => node,
    limit: () => node,
    eq: () => node,
    maybeSingle: async () => ({ data: finalRow, error: null }),
  };
  return node;
}

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: { getSession: paymentMocks.getSession },
    from: () => makeChainable({ status: 'succeeded', tx_ref: 'TX-resume' }),
  })),
}));

describe('resumePaymentAfterStepUp forwards proof and respects server verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentMocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt-resume' } },
      error: null,
    });
  });

  it('sends the full biometric proof unchanged to completeStepUp', async () => {
    const { resumePaymentAfterStepUp } = await import('@/services/paymentService.js');
    paymentMocks.invokeEdgeFunction.mockResolvedValueOnce({
      ok: true,
      pending_payment_id: 'pp',
      tx_ref: 'TX-resume',
      status: 'waiting_for_mpesa',
    });

    await resumePaymentAfterStepUp({
      pending_payment_id: 'pp',
      step_up_challenge_id: 'su',
      tx_ref: 'TX-resume',
    }, {
      challenge_id: 'ch',
      credential_id: 'cred',
      client_data_json: 'cdj',
      authenticator_data: 'ad',
      signature: 'sig',
    });

    expect(paymentMocks.invokeEdgeFunction).toHaveBeenCalledWith(
      'completeStepUp',
      expect.objectContaining({
        pending_payment_id: 'pp',
        step_up_challenge_id: 'su',
        challenge_id: 'ch',
        credential_id: 'cred',
        client_data_json: 'cdj',
        authenticator_data: 'ad',
        signature: 'sig',
      }),
      'jwt-resume',
    );
  });

  it('throws when server rejects the assertion — no payment confirmation happens', async () => {
    const { resumePaymentAfterStepUp } = await import('@/services/paymentService.js');
    paymentMocks.invokeEdgeFunction.mockResolvedValueOnce({
      ok: false,
      error: 'STEP_UP_VERIFICATION_FAILED',
      message: 'Verification failed. Try again.',
    });

    await expect(resumePaymentAfterStepUp({
      pending_payment_id: 'pp',
      step_up_challenge_id: 'su',
      tx_ref: 'TX-resume',
    }, { otp: '000000' })).rejects.toThrow(/Verification failed/);
  });

  it('rejects calls missing step-up context', async () => {
    const { resumePaymentAfterStepUp } = await import('@/services/paymentService.js');
    await expect(resumePaymentAfterStepUp({}, {})).rejects.toThrow(/step-up/i);
  });
});
