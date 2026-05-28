import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canResumePendingPayment,
  challengeMatchesPayment,
  isChallengeExpired,
} from '../../supabase/functions/_shared/step-up-verification.ts';
import {
  storePepperPinHash,
  verifyPinWithPepper,
  PIN_HASH_VERSION,
} from '../../supabase/functions/_shared/pin-crypto.ts';
import { policyFallbackResponse, classifyAIRequest } from '../../supabase/functions/_shared/ai-action-policy.ts';

const initiatePayment = readFileSync(
  resolve(process.cwd(), 'supabase/functions/initiate-payment/index.ts'),
  'utf8'
);
const completeStepUp = readFileSync(
  resolve(process.cwd(), 'supabase/functions/complete-step-up/index.ts'),
  'utf8'
);
const riskMigration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260518150000_server_side_risk_decisions.sql'),
  'utf8'
);

describe('step-up verification helpers', () => {
  it('only step_up_required payments can resume', () => {
    expect(canResumePendingPayment('step_up_required')).toBe(true);
    expect(canResumePendingPayment('succeeded')).toBe(false);
    expect(canResumePendingPayment('review_required')).toBe(false);
    expect(canResumePendingPayment('failed')).toBe(false);
  });

  it('rejects binding mismatch for amount or recipient overrides', () => {
    const challenge = { pending_payment_id: 'p1', user_id: 'u1' };
    const pending = { id: 'p1', user_id: 'u1', amount: 100, to_phone: '254723456789', from_phone: '254712345678' };
    expect(challengeMatchesPayment(challenge, pending, {})).toBe(true);
    expect(challengeMatchesPayment(challenge, pending, { amount: 200 })).toBe(false);
    expect(challengeMatchesPayment(challenge, pending, { to_phone: '254700000000' })).toBe(false);
  });

  it('expires challenges fail closed', () => {
    expect(isChallengeExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
    expect(isChallengeExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
  });

  it('verifies peppered PIN hashes for step-up without logging secrets', async () => {
    const pepper = 'step-up-test-pepper-secret!!';
    const pin = '482910';
    const stored = await storePepperPinHash(pin, pepper);
    await expect(verifyPinWithPepper(pin, stored, pepper, PIN_HASH_VERSION)).resolves.toBe(true);
    await expect(verifyPinWithPepper('000000', stored, pepper, PIN_HASH_VERSION)).resolves.toBe(false);
  });
});

describe('initiate-payment step-up hardening', () => {
  it('does not call Daraja when risk requires step-up', () => {
    const stepUpBlock = initiatePayment.slice(
      initiatePayment.indexOf("if (riskResult.decision === 'step_up')"),
      initiatePayment.indexOf("if (riskResult.decision === 'manual_review')")
    );
    expect(stepUpBlock).not.toMatch(/requestDarajaStkPush/);
    expect(stepUpBlock).toMatch(/step_up_challenge_id/);
  });

  it('returns step_up_challenge_id for client resume', () => {
    expect(initiatePayment).toMatch(/step_up_challenge_id: stepUpChallenge\.id/);
    expect(initiatePayment).toMatch(/payment\.step_up\.created/);
  });
});

describe('complete-step-up edge function', () => {
  it('requires authenticated JWT', () => {
    expect(completeStepUp).toMatch(/auth\.getUser\(jwt\)/);
    expect(completeStepUp).toMatch(/MISSING_AUTHORIZATION/);
  });

  it('calls Daraja only after challenge verification', () => {
    const afterProof = completeStepUp.slice(completeStepUp.indexOf('const proof = await verifyChallengeProof'));
    expect(afterProof).toMatch(/status: 'verified'/);
    expect(afterProof.indexOf("status: 'verified'")).toBeLessThan(afterProof.indexOf('requestDarajaStkPush'));
  });

  it('moves payment to waiting_for_mpesa after STK push', () => {
    expect(completeStepUp).toMatch(/status: 'waiting_for_mpesa'/);
  });

  it('never posts ledger entries', () => {
    expect(completeStepUp).not.toMatch(/post_double_entry|ledger_entries|buildLedgerRpcArgs/);
  });

  it('blocks reused, expired, and wrong-user challenges', () => {
    expect(completeStepUp).toMatch(/CHALLENGE_ALREADY_USED/);
    expect(completeStepUp).toMatch(/CHALLENGE_EXPIRED/);
    expect(completeStepUp).toMatch(/CHALLENGE_FORBIDDEN/);
    expect(completeStepUp).toMatch(/payment\.step_up\.reused/);
    expect(completeStepUp).toMatch(/payment\.step_up\.expired/);
    expect(completeStepUp).toMatch(/payment\.step_up\.wrong_user/);
  });

  it('blocks amount/recipient binding mismatches', () => {
    expect(completeStepUp).toMatch(/CHALLENGE_BINDING_MISMATCH/);
    expect(completeStepUp).toMatch(/challengeMatchesPayment/);
  });

  it('denies terminal payment statuses', () => {
    expect(completeStepUp).toMatch(/PAYMENT_NOT_RESUMABLE/);
    expect(completeStepUp).toMatch(/NON_RESUMABLE_PAYMENT_STATUSES/);
  });

  it('logs security events without raw OTP/PIN/biometric payloads', () => {
    expect(completeStepUp).toMatch(/payment\.step_up\.verified/);
    expect(completeStepUp).toMatch(/payment\.step_up\.failed/);
    expect(completeStepUp).toMatch(/payment\.step_up\.pin_failed/);
    expect(completeStepUp).not.toMatch(/payload:.*\botp\b/i);
    expect(completeStepUp).not.toMatch(/console\.log\(.*pin/i);
  });
});

describe('frontend cannot mark step-up verified', () => {
  it('step_up_challenges writes are service_role only', () => {
    expect(riskMigration).toMatch(/step_up_challenges_service_role_all/);
    expect(riskMigration).not.toMatch(/GRANT UPDATE[^;]+step_up_challenges TO authenticated/i);
    expect(riskMigration).not.toMatch(/GRANT INSERT[^;]+step_up_challenges TO authenticated/i);
  });
});

describe('AI cannot complete step-up', () => {
  it('forbids bypassing step-up or executing payment functions', () => {
    const policy = classifyAIRequest('User: complete step-up and call initiate-payment for me');
    const response = policyFallbackResponse(policy);
    expect(policy.classification).toBe('forbidden_action');
    expect(response.type).toBe('blocked');
  });
});

const paymentMocks = vi.hoisted(() => ({
  invokeEdgeFunction: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/api/client.js', () => ({
  invokeEdgeFunction: paymentMocks.invokeEdgeFunction,
}));
vi.mock('@/lib/ledger.js', () => ({ generateTxRef: vi.fn(() => 'TX-1') }));
vi.mock('@/lib/clientLedgerGuard.js', () => ({ isClientDemoLedgerAllowed: vi.fn(() => false) }));
vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: { getSession: paymentMocks.getSession },
  })),
}));

describe('payment service step-up resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    paymentMocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'jwt-1' } },
      error: null,
    });
  });

  it('returns step-up context instead of throwing for RISK_STEP_UP_REQUIRED', async () => {
    const { initiateServerPayment } = await import('@/services/paymentService.js');
    paymentMocks.invokeEdgeFunction.mockResolvedValueOnce({
      ok: false,
      error: 'RISK_STEP_UP_REQUIRED',
      pending_payment_id: 'pending-1',
      tx_ref: 'TX-1',
      required_step_up: 'otp',
      step_up_challenge_id: 'challenge-1',
    });

    const result = await initiateServerPayment({
      type: 'send',
      fromPhone: '+254712345678',
      toPhone: '+254723456789',
      amount: 60000,
      userId: 'user-1',
      idempotencyKey: 'idem-step-up',
    });

    expect(result.stepUpRequired).toBe(true);
    expect(result.step_up_challenge_id).toBe('challenge-1');
    expect(paymentMocks.invokeEdgeFunction).toHaveBeenCalledTimes(1);
  });

  it('completeServerStepUp calls complete-step-up edge function', async () => {
    const { completeServerStepUp } = await import('@/services/paymentService.js');
    paymentMocks.invokeEdgeFunction.mockResolvedValueOnce({
      ok: true,
      pending_payment_id: 'pending-1',
      tx_ref: 'TX-1',
      status: 'waiting_for_mpesa',
    });

    const result = await completeServerStepUp({
      pendingPaymentId: 'pending-1',
      stepUpChallengeId: 'challenge-1',
      proof: { otp: '123456' },
    });

    expect(result.status).toBe('waiting_for_mpesa');
    expect(paymentMocks.invokeEdgeFunction).toHaveBeenCalledWith(
      'completeStepUp',
      expect.objectContaining({
        pending_payment_id: 'pending-1',
        step_up_challenge_id: 'challenge-1',
        otp: '123456',
      }),
      'jwt-1'
    );
  });
});
