// Client-side risk computation is intentionally MINIMAL. Real risk
// scoring happens server-side in initiate-payment via
// _shared/risk-engine.ts. The localStorage-based reputation overlay
// from src/backend/fraud was removed in Phase 5.2 (Prompt 5.2).
// This file now only does pre-flight client-side hints (UX) —
// the server's risk_decision is the source of truth.

import { evaluateSimSwapRisk, RISK_LEVEL } from './simSwapDetector';
import { isCurrentDeviceTrusted, getRiskHistory } from './deviceTrust';

// ── Transaction signal weights ────────────────────────────────────────────────

const TX_WEIGHTS = {
  amountVeryHigh:    40,   // > 50,000 KSh
  amountHigh:        25,   // > 20,000 KSh
  amountMedium:      12,   // >  5,000 KSh
  newRecipient:      20,
  unusualAmount:     18,
  failedAttempts:    25,
  locationMismatch:  30,
  untrustedDevice:   20,
  airtimeHigh:       10,
  nighttimeTx:        8,   // 00:00–05:00 local time
  paybillLarge:      15,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isNighttime() {
  const h = new Date().getHours();
  return h >= 0 && h < 5;
}

function recentRiskSpike() {
  // Check if there was a HIGH+ risk event in the last 30 min
  const history = getRiskHistory();
  const cutoff  = Date.now() - 30 * 60 * 1000;
  return history.some(e => e.ts > cutoff && (e.level === 'HIGH' || e.level === 'CRITICAL'));
}

// ── Core evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate full transaction + device risk.
 *
 * @param {object} params
 * @param {number}  params.amount
 * @param {string}  params.recipient
 * @param {string}  params.actionType       — 'transfer' | 'airtime' | 'paybill' | 'fuliza'
 * @param {boolean} params.newRecipient
 * @param {boolean} params.unusualAmount
 * @param {number}  params.failedAttempts
 * @param {boolean} params.locationMismatch
 * @param {boolean} params.skipSimSwapCheck  — for lightweight calls (e.g. read-only views)
 *
 * @returns {{ riskLevel, score, requiredAuth, factors, holdTransaction, simSwapResult }}
 */
export function evaluateRisk({
  amount           = 0,
  recipient        = '',
  actionType       = 'transfer',
  newRecipient     = false,
  unusualAmount    = false,
  failedAttempts   = 0,
  locationMismatch = false,
  skipSimSwapCheck = false,
} = {}) {
  let score  = 0;
  const factors = [];

  // ── Transaction signals ──────────────────────────────────────────────
  if (amount > 50000) {
    score += TX_WEIGHTS.amountVeryHigh;
    factors.push('Very high transaction amount (>KSh 50,000)');
  } else if (amount > 20000) {
    score += TX_WEIGHTS.amountHigh;
    factors.push('High transaction amount (>KSh 20,000)');
  } else if (amount > 5000) {
    score += TX_WEIGHTS.amountMedium;
    factors.push('Moderate transaction amount (>KSh 5,000)');
  }

  if (newRecipient) {
    score += TX_WEIGHTS.newRecipient;
    factors.push('New or unrecognised recipient');
  }

  if (unusualAmount) {
    score += TX_WEIGHTS.unusualAmount;
    factors.push('Amount deviates from your normal pattern');
  }

  if (failedAttempts >= 2) {
    score += TX_WEIGHTS.failedAttempts;
    factors.push(`${failedAttempts} recent failed authentication attempts`);
  }

  if (locationMismatch) {
    score += TX_WEIGHTS.locationMismatch;
    factors.push('Transaction from unusual location');
  }

  if (actionType === 'airtime' && amount > 2000) {
    score += TX_WEIGHTS.airtimeHigh;
    factors.push('High-value airtime purchase');
  }

  if (actionType === 'paybill' && amount > 30000) {
    score += TX_WEIGHTS.paybillLarge;
    factors.push('Large Paybill transaction');
  }

  if (isNighttime()) {
    score += TX_WEIGHTS.nighttimeTx;
    factors.push('Transaction outside normal hours (00:00–05:00)');
  }

  // ── Device trust ─────────────────────────────────────────────────────
  const deviceTrusted = isCurrentDeviceTrusted();
  if (!deviceTrusted) {
    score += TX_WEIGHTS.untrustedDevice;
    factors.push('Transaction from unrecognised device');
  }

  // ── Recent risk history spike ─────────────────────────────────────────
  if (recentRiskSpike()) {
    score += 20;
    factors.push('Elevated risk activity detected in the last 30 minutes');
  }

  // ── SIM-swap / device integrity check ─────────────────────────────────
  let simSwapResult = null;
  if (!skipSimSwapCheck) {
    simSwapResult = evaluateSimSwapRisk({ transactionAmount: amount });
    if (simSwapResult.score > 0) {
      // Blend SIM-swap score (weighted 50%) into overall score
      score += Math.round(simSwapResult.score * 0.5);
      simSwapResult.signals.forEach(s => {
        factors.push(`Device integrity: ${s.detail}`);
      });
    }
  }

  // ── Final scoring ──────────────────────────────────────────────────────
  const clampedScore = Math.min(100, score);
  const riskLevel    = scoreToLevel(clampedScore, simSwapResult);
  const requiredAuth = resolveAuth(riskLevel, simSwapResult);
  const holdTransaction = riskLevel === RISK_LEVEL.HIGH || riskLevel === RISK_LEVEL.CRITICAL;

  return {
    riskLevel,
    score: clampedScore,
    requiredAuth,
    factors,
    holdTransaction,
    simSwapResult,
    // Legacy compat
    deviceTrusted,
  };
}

// ── Level resolver ────────────────────────────────────────────────────────────

function scoreToLevel(score, simSwapResult) {
  // If SIM-swap detector independently flags CRITICAL, escalate regardless of score
  if (simSwapResult?.level === RISK_LEVEL.CRITICAL) return RISK_LEVEL.CRITICAL;
  if (simSwapResult?.level === RISK_LEVEL.HIGH && score >= 40) return RISK_LEVEL.CRITICAL;
  if (score >= 70) return RISK_LEVEL.CRITICAL;
  if (score >= 45) return RISK_LEVEL.HIGH;
  if (score >= 20) return RISK_LEVEL.MEDIUM;
  return RISK_LEVEL.LOW;
}

// ── Auth step resolver ────────────────────────────────────────────────────────

function resolveAuth(level, simSwapResult) {
  if (level === RISK_LEVEL.CRITICAL) {
    return ['logout', 'full_reauthentication'];
  }
  if (level === RISK_LEVEL.HIGH) {
    const steps = ['pin', 'face'];
    if (simSwapResult?.signals?.some(s => s.severity === 'critical' || s.severity === 'high')) {
      steps.push('voice');
    }
    return steps;
  }
  if (level === RISK_LEVEL.MEDIUM) return ['pin', 'face'];
  return ['pin'];
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

export function getRiskColor(requiredAuth = []) {
  if (requiredAuth.includes('logout'))  return 'text-red-400';
  if (requiredAuth.includes('voice'))   return 'text-red-400';
  if (requiredAuth.includes('face'))    return 'text-amber-400';
  return 'text-primary';
}

export function getRiskBadgeConfig(riskLevel) {
  switch (riskLevel) {
    case RISK_LEVEL.CRITICAL: return { color: 'text-red-400',    bg: 'bg-red-400/10',    border: 'border-red-400/20',    label: 'Critical Risk'  };
    case RISK_LEVEL.HIGH:     return { color: 'text-red-400',    bg: 'bg-red-400/8',     border: 'border-red-400/15',    label: 'High Risk'      };
    case RISK_LEVEL.MEDIUM:   return { color: 'text-amber-400',  bg: 'bg-amber-400/10',  border: 'border-amber-400/20',  label: 'Medium Risk'    };
    default:                  return { color: 'text-primary',    bg: 'bg-primary/10',    border: 'border-primary/20',    label: 'Low Risk'       };
  }
}

export { RISK_LEVEL };
