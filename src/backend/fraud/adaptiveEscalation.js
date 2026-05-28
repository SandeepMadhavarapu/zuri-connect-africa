/**
 * Adaptive fraud escalation.
 * Converts graph, shared intel, reputation, and device risk into auth actions.
 */

import { evaluateDeviceRisk } from '@/lib/deviceTrust';
import { evaluateCounterpartyReputation } from './reputationEngine';
import { evaluateSharedThreat } from './threatIntel';

export const ESCALATION_ACTION = {
  PIN: 'pin',
  FACE_ID: 'face_id',
  WEBAUTHN: 'webauthn',
  STEP_UP: 'step_up_auth',
  PENDING_REVIEW: 'pending_review',
  TEMPORARY_HOLD: 'temporary_hold',
};

function levelFromScore(score) {
  if (score >= 85) return 'critical';
  if (score >= 65) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

export function evaluateAdaptiveFraudEscalation({
  amount = 0,
  recipient,
  merchant,
  message,
  txPattern,
  deviceContext = {},
  velocity = 0,
  simSwapSignal = false,
} = {}) {
  const reputation = evaluateCounterpartyReputation({
    recipient,
    merchant,
    deviceId: deviceContext.deviceId,
  });
  const sharedThreat = evaluateSharedThreat({ message, recipient, merchant, txPattern, amount });
  const deviceRisk = evaluateDeviceRisk({ ...deviceContext, simSwapSignal });

  let score = 0;
  const reasons = [];

  score += Math.min(35, Math.round(amount / 2000));
  score += reputation.riskScore || 0;
  score += sharedThreat.sensitivityBump || 0;
  score += Math.round((deviceRisk.score || 0) * 0.45);
  score += Math.min(25, velocity * 5);

  if (!reputation.known) reasons.push('new_counterparty');
  if (reputation.riskScore >= 60) reasons.push('counterparty_reputation_high');
  if (sharedThreat.matched) reasons.push(...sharedThreat.warnings);
  if (deviceRisk.signals?.length) reasons.push(...deviceRisk.signals.map(signal => signal.code));
  if (simSwapSignal) reasons.push('sim_swap_indicator');
  if (velocity >= 5) reasons.push('transaction_velocity_high');

  const clamped = Math.min(100, score);
  const level = levelFromScore(clamped);
  const actions = [ESCALATION_ACTION.PIN];

  if (clamped >= 35) actions.push(ESCALATION_ACTION.FACE_ID);
  if (clamped >= 55) actions.push(ESCALATION_ACTION.WEBAUTHN, ESCALATION_ACTION.STEP_UP);
  if (clamped >= 75) actions.push(ESCALATION_ACTION.PENDING_REVIEW);
  if (clamped >= 85) actions.push(ESCALATION_ACTION.TEMPORARY_HOLD);

  return {
    score: clamped,
    level,
    actions: Array.from(new Set(actions)),
    holdTransaction: clamped >= 75,
    settlementDelayMs: clamped >= 85 ? 15 * 60 * 1000 : clamped >= 65 ? 2 * 60 * 1000 : 0,
    throttle: clamped >= 65,
    reasons: Array.from(new Set(reasons)),
    reputation,
    sharedThreat,
    deviceRisk,
  };
}
