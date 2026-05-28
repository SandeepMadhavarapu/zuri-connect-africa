/**
 * Zuri Connect Africa — SIM Swap & Account Takeover Detector
 *
 * Signals monitored:
 *   1. Fingerprint drift mid-session (canvas, GPU, UA, platform)
 *   2. Timezone / locale shift vs. enrolled baseline
 *   3. Rapid device switching (>2 unique fingerprints in 24h)
 *   4. Screen geometry flip (portrait↔landscape swap outside normal rotation)
 *   5. User-agent substring change (OS upgrade vs. spoofed UA)
 *   6. Repeated auth failures from a new fingerprint
 *   7. High-velocity login attempts (brute-force signal)
 *   8. Session binding divergence above threshold
 *
 * Each signal contributes a weighted score to a 0–100 SIM-swap risk index.
 * Risk levels: LOW (<25) | MEDIUM (25–54) | HIGH (55–79) | CRITICAL (≥80)
 */

import {
  collectDeviceSignals,
  computeSignalDivergence,
  computeFingerprintId,
  getCurrentDevice,
  verifySessionBinding,
  appendRiskEvent,
  getRiskHistory,
} from './deviceTrust';
import { emit } from './eventBus';

// ── Signal weights ────────────────────────────────────────────────────────────

const WEIGHTS = {
  FINGERPRINT_DRIFT:        30,   // strong — GPU/canvas changed
  USERAGENT_CHANGE:         20,   // platform/browser swap
  PLATFORM_CHANGE:          20,   // OS/device type flip
  TIMEZONE_SHIFT:           15,   // mid-session timezone change
  RAPID_DEVICE_SWITCH:      25,   // >2 fps in 24h window
  AUTH_FAILURE_SPIKE:       20,   // ≥3 failures in 10 min
  SESSION_BINDING_BROKEN:   35,   // session no longer matches creation fingerprint
  NEW_DEVICE_HIGH_AMOUNT:   15,   // first-time device + large tx
  LOCALE_MISMATCH:          10,   // language/locale changed
};

// ── Risk level thresholds ─────────────────────────────────────────────────────

export const RISK_LEVEL = {
  LOW:      'LOW',
  MEDIUM:   'MEDIUM',
  HIGH:     'HIGH',
  CRITICAL: 'CRITICAL',
};

function scoreToLevel(score) {
  if (score >= 80) return RISK_LEVEL.CRITICAL;
  if (score >= 55) return RISK_LEVEL.HIGH;
  if (score >= 25) return RISK_LEVEL.MEDIUM;
  return RISK_LEVEL.LOW;
}

// ── Velocity tracking ─────────────────────────────────────────────────────────

const VELOCITY_KEY  = 'zuri_fp_velocity';
const FAILURE_KEY   = 'zuri_auth_velocity';

function getVelocityLog(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}
function setVelocityLog(key, log) {
  try { localStorage.setItem(key, JSON.stringify(log)); } catch {}
}

/** Record a fingerprint observation and return unique fp count in past 24h */
function recordFingerprintObservation(fpId) {
  const log = getVelocityLog(VELOCITY_KEY);
  const now = Date.now();
  log.push({ fpId, ts: now });
  // Keep only last 24h
  const pruned = log.filter(e => now - e.ts < 24 * 60 * 60 * 1000);
  setVelocityLog(VELOCITY_KEY, pruned);
  const uniqueFps = new Set(pruned.map(e => e.fpId));
  return uniqueFps.size;
}

/** Record an auth failure and return count in past 10 min */
export function recordAuthFailureVelocity() {
  const log = getVelocityLog(FAILURE_KEY);
  const now = Date.now();
  log.push({ ts: now });
  const pruned = log.filter(e => now - e.ts < 10 * 60 * 1000);
  setVelocityLog(FAILURE_KEY, pruned);
  return pruned.length;
}

export function clearAuthFailureVelocity() {
  setVelocityLog(FAILURE_KEY, []);
}

// ── Core evaluation ───────────────────────────────────────────────────────────

/**
 * Run the full SIM-swap risk evaluation.
 *
 * @param {object} opts
 * @param {number}  opts.transactionAmount  — KSh (for new-device-high-amount signal)
 * @param {boolean} opts.isNewRecipient
 * @returns {{ score, level, signals, requiredActions }}
 */
export function evaluateSimSwapRisk(opts = {}) {
  const signals   = [];
  let   score     = 0;

  const device    = getCurrentDevice();
  const current   = collectDeviceSignals();
  const stored    = device.signals || {};
  const fpId      = computeFingerprintId(current);

  // 1. Fingerprint drift (canvas / GPU / platform)
  const divergence = computeSignalDivergence(stored, current);
  if (divergence > 0.35) {
    score += Math.round(WEIGHTS.FINGERPRINT_DRIFT * Math.min(divergence / 0.5, 1));
    signals.push({ code: 'FINGERPRINT_DRIFT', detail: `Divergence ${(divergence * 100).toFixed(0)}%`, severity: 'high' });
  }

  // 2. User-agent change
  if (stored.userAgent && stored.userAgent !== current.userAgent) {
    score += WEIGHTS.USERAGENT_CHANGE;
    signals.push({ code: 'USERAGENT_CHANGE', detail: 'Browser/OS signature changed', severity: 'high' });
  }

  // 3. Platform change
  if (stored.platform && stored.platform !== current.platform) {
    score += WEIGHTS.PLATFORM_CHANGE;
    signals.push({ code: 'PLATFORM_CHANGE', detail: 'Device platform changed', severity: 'high' });
  }

  // 4. Timezone shift
  if (stored.timezone && stored.timezone !== current.timezone) {
    score += WEIGHTS.TIMEZONE_SHIFT;
    signals.push({ code: 'TIMEZONE_SHIFT', detail: `${stored.timezone} → ${current.timezone}`, severity: 'medium' });
  }

  // 5. Rapid device switching (velocity)
  const uniqueDevices = recordFingerprintObservation(fpId);
  if (uniqueDevices > 2) {
    score += Math.min(WEIGHTS.RAPID_DEVICE_SWITCH, (uniqueDevices - 2) * 10);
    signals.push({ code: 'RAPID_DEVICE_SWITCH', detail: `${uniqueDevices} unique devices in 24h`, severity: 'high' });
  }

  // 6. Auth failure spike
  const recentFailures = getVelocityLog(FAILURE_KEY).filter(e => Date.now() - e.ts < 10 * 60 * 1000).length;
  if (recentFailures >= 3) {
    score += Math.min(WEIGHTS.AUTH_FAILURE_SPIKE, recentFailures * 5);
    signals.push({ code: 'AUTH_FAILURE_SPIKE', detail: `${recentFailures} failures in 10 min`, severity: 'high' });
  }

  // 7. Session binding broken
  const binding = verifySessionBinding();
  if (!binding.valid && binding.anomalies.length > 0) {
    score += WEIGHTS.SESSION_BINDING_BROKEN;
    signals.push({ code: 'SESSION_BINDING_BROKEN', detail: binding.anomalies.join(', '), severity: 'critical' });
  }

  // 8. New device + large transaction
  if (!device.isTrusted && (opts.transactionAmount || 0) > 10000) {
    score += WEIGHTS.NEW_DEVICE_HIGH_AMOUNT;
    signals.push({ code: 'NEW_DEVICE_HIGH_AMOUNT', detail: `Untrusted device + KSh ${opts.transactionAmount?.toLocaleString()}`, severity: 'medium' });
  }

  // 9. Locale mismatch
  if (stored.locale && stored.locale !== current.locale) {
    score += WEIGHTS.LOCALE_MISMATCH;
    signals.push({ code: 'LOCALE_MISMATCH', detail: `${stored.locale} → ${current.locale}`, severity: 'low' });
  }

  const clampedScore = Math.min(100, score);
  const level        = scoreToLevel(clampedScore);

  // Determine required escalation actions
  const requiredActions = resolveRequiredActions(level, signals);

  // Persist to risk history
  if (clampedScore > 0) {
    appendRiskEvent({ score: clampedScore, level, signals: signals.map(s => s.code) });
  }

  // Emit for audit / observability
  if (level !== RISK_LEVEL.LOW) {
    emit('SIM_SWAP_RISK', { score: clampedScore, level, signals });
    console.warn(`[SimSwapDetector] Risk: ${level} (${clampedScore}/100)`, signals.map(s => s.code));
  }

  return { score: clampedScore, level, signals, requiredActions };
}

// ── Escalation resolver ───────────────────────────────────────────────────────

/**
 * Map risk level + active signals to required auth steps.
 * Returns an ordered array of required actions.
 */
function resolveRequiredActions(level, signals) {
  const codes = signals.map(s => s.code);

  if (level === RISK_LEVEL.CRITICAL || codes.includes('SESSION_BINDING_BROKEN')) {
    return ['logout', 'full_reauthentication'];
  }

  if (level === RISK_LEVEL.HIGH) {
    return ['pin', 'face_id', 'hold_transactions'];
  }

  if (level === RISK_LEVEL.MEDIUM) {
    if (codes.includes('RAPID_DEVICE_SWITCH') || codes.includes('AUTH_FAILURE_SPIKE')) {
      return ['pin', 'face_id'];
    }
    return ['pin'];
  }

  return []; // LOW — no step-up needed
}

// ── Periodic background check ─────────────────────────────────────────────────

let _monitorTimer = null;

/**
 * Start a background monitor that re-evaluates risk every 3 minutes.
 * Emits SIM_SWAP_RISK event if level escalates.
 * Call stopSimSwapMonitor() to clean up.
 */
export function startSimSwapMonitor(onRiskEscalation) {
  let lastLevel = RISK_LEVEL.LOW;

  function check() {
    const result = evaluateSimSwapRisk();
    if (result.level !== lastLevel && result.level !== RISK_LEVEL.LOW) {
      lastLevel = result.level;
      onRiskEscalation?.(result);
    }
    const intervalMs = result.level === RISK_LEVEL.LOW ? 3 * 60 * 1000 : 60 * 1000;
    _monitorTimer = setTimeout(check, intervalMs);
  }

  check();
  return () => clearTimeout(_monitorTimer);
}

export function stopSimSwapMonitor() {
  clearTimeout(_monitorTimer);
}

// ── SIM swap summary for UI ───────────────────────────────────────────────────

/**
 * Get a human-readable summary for the Security Centre UI.
 */
export function getSimSwapSummary() {
  const history = getRiskHistory();
  const recent  = history.filter(e => Date.now() - e.ts < 24 * 60 * 60 * 1000);
  const highest = recent.reduce((max, e) => Math.max(max, e.score || 0), 0);

  return {
    eventsLast24h:    recent.length,
    highestScore:     highest,
    highestLevel:     scoreToLevel(highest),
    allClear:         highest < 25,
    lastCheckAt:      history.length > 0 ? history[history.length - 1].ts : null,
  };
}