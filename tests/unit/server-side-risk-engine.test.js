import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateRisk, publicRiskMessage } from '../../supabase/functions/_shared/risk-engine.ts';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260518150000_server_side_risk_decisions.sql'),
  'utf8'
);
const initiatePayment = readFileSync(
  resolve(process.cwd(), 'supabase/functions/initiate-payment/index.ts'),
  'utf8'
);

const baseInput = {
  userId: 'user-1',
  txRef: 'TX-RISK-1',
  amount: 1000,
  paymentType: 'send',
  fromPhone: '254712345678',
  toPhone: '254723456789',
  idempotencyKey: 'idem-risk-1',
  now: new Date('2026-05-18T12:00:00.000Z'),
  accountAgeDays: 100,
  recentPaymentCountHour: 0,
  recentPaymentCountDay: 0,
  dailyTotalAmount: 0,
  monthlyTotalAmount: 0,
  newRecipient: false,
  failedOtpAttempts: 0,
  newDevice: false,
  impossibleTravel: false,
  recentSimOrAccountChange: false,
  recentReversalCount: 0,
  recipientRiskScore: 0,
};

describe('server-side risk engine', () => {
  it('low-risk payment proceeds to STK Push path', () => {
    const result = evaluateRisk(baseInput);
    expect(result).toMatchObject({
      decision: 'allow',
      risk_score: 0,
      reasons: [],
    });
    expect(initiatePayment.indexOf('evaluateRisk(riskInput)')).toBeLessThan(
      initiatePayment.indexOf('await requestDarajaStkPush')
    );
  });

  it('high amount triggers step_up before Daraja', () => {
    const result = evaluateRisk({ ...baseInput, amount: 60000 });
    expect(result.decision).toBe('step_up');
    expect(result.required_step_up).toBe('pin');
    expect(publicRiskMessage(result)).toBe('We need one more verification step.');
    expect(initiatePayment).toMatch(/step_up_challenge_id/);
    const stepUpBlock = initiatePayment.slice(
      initiatePayment.indexOf("if (riskResult.decision === 'step_up')"),
      initiatePayment.indexOf("if (riskResult.decision === 'manual_review')")
    );
    expect(stepUpBlock).not.toMatch(/requestDarajaStkPush/);
  });

  it('velocity abuse triggers block or manual_review', () => {
    const result = evaluateRisk({
      ...baseInput,
      amount: 2500,
      recentPaymentCountHour: 12,
      recentPaymentCountDay: 34,
    });
    expect(['block', 'manual_review']).toContain(result.decision);
    expect(result.reasons).toContain('velocity_abuse');
  });

  it('frontend cannot forge an allow decision', () => {
    const result = evaluateRisk({
      ...baseInput,
      amount: 120000,
      clientRiskOverridePresent: true,
    });
    expect(result.decision).not.toBe('allow');
    expect(result.reasons).toContain('client_risk_override_ignored');
  });

  it('AI cannot bypass risk decision', () => {
    const result = evaluateRisk({
      ...baseInput,
      amount: 1000,
      recipientRiskScore: 95,
      clientRiskOverridePresent: true,
    });
    expect(result.decision).toBe('block');
    expect(result.reasons).toContain('critical_recipient_risk');
  });
});

describe('risk database hardening', () => {
  it('risk decisions are service_role-only for writes', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.risk_decisions/i);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/i);
    expect(migration).toMatch(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.%I TO service_role/i);
    expect(migration).not.toMatch(/GRANT INSERT[^;]+risk_decisions TO authenticated/i);
    expect(migration).not.toMatch(/GRANT UPDATE[^;]+risk_decisions TO authenticated/i);
  });

  it('step-up and security event tables are service-role written', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.step_up_challenges/i);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.security_events/i);
    expect(migration).toMatch(/step_up_challenges_service_role_all/);
    expect(migration).toMatch(/security_events_service_role_all/);
  });
});
