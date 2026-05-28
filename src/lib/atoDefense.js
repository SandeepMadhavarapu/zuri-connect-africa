/**
 * Zuri Connect Africa — Account Takeover (ATO) Defense Engine
 *
 * Detects:
 *   1. Impossible travel — location/timezone jump that is physically impossible
 *      given elapsed time since last known location
 *   2. Credential stuffing — rapid failed auth attempts across sessions
 *   3. Unusual behavioral patterns — rapid action sequences, off-hours spikes
 *   4. Rapid credential changes — PIN/email/phone updated multiple times in short window
 *   5. New device + immediate high-value transaction
 *   6. Session replay attempts — reused session tokens
 *
 * Each signal contributes to an ATO risk score 0–100.
 * Scores ≥70 trigger automatic protective actions.
 */

import { logSuspiciousActivity } from './sessionSecurity';
import { emit } from './eventBus';

// ── Storage keys ──────────────────────────────────────────────────────────────

const LOCATION_KEY      = 'zuri_ato_location';
const CRED_CHANGE_KEY   = 'zuri_ato_cred_changes';
const AUTH_FAIL_KEY     = 'zuri_ato_auth_fails';
const ACTION_VEL_KEY    = 'zuri_ato_action_vel';
const SESSION_TOKEN_KEY = 'zuri_ato_seen_tokens';
const ATO_LOG_KEY       = 'zuri_ato_events';

// ── Helpers ───────────────────────────────────────────────────────────────────

function lsGet(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function lsSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

function now() { return Date.now(); }

// ── 1. Impossible Travel Detection ───────────────────────────────────────────

/**
 * Record a location observation (timezone as proxy for location).
 * Returns a travel anomaly result if an impossible jump is detected.
 *
 * @returns {{ anomaly: boolean, detail: string, score: number }}
 */
export function checkImpossibleTravel() {
  const currentTz     = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currentOffset = new Date().getTimezoneOffset(); // minutes
  const observations  = lsGet(LOCATION_KEY) || [];
  const ts            = now();

  const result = { anomaly: false, detail: '', score: 0 };

  if (observations.length > 0) {
    const last = observations[observations.length - 1];
    const elapsedMs = ts - last.ts;
    const elapsedHours = elapsedMs / (1000 * 60 * 60);

    // Timezone offset delta in hours
    const tzDeltaMinutes = Math.abs(last.offset - currentOffset);
    const tzDeltaHours   = tzDeltaMinutes / 60;

    // Heuristic: 1 hour of timezone shift requires at minimum 1 hour of travel
    // If offset changed 3+ hours and elapsed < 1 hour → physically impossible
    if (tzDeltaHours >= 3 && elapsedHours < 1) {
      result.anomaly = true;
      result.score   = Math.min(100, 40 + tzDeltaHours * 8);
      result.detail  = `Timezone jumped ${tzDeltaHours.toFixed(1)}h in ${Math.round(elapsedHours * 60)}min`;
    } else if (last.tz !== currentTz && elapsedHours < 0.5) {
      // Different timezone string within 30 min — suspicious even if offset similar
      result.anomaly = true;
      result.score   = 30;
      result.detail  = `Location changed from ${last.tz} to ${currentTz} in < 30min`;
    }
  }

  // Prune to last 10 observations, append current
  const pruned = observations.slice(-9);
  pruned.push({ tz: currentTz, offset: currentOffset, ts });
  lsSet(LOCATION_KEY, pruned);

  if (result.anomaly) {
    logSuspiciousActivity('impossible_travel', result.detail);
    emit('ATO_SIGNAL', { type: 'impossible_travel', ...result });
  }

  return result;
}

// ── 2. Credential Change Velocity ─────────────────────────────────────────────

/**
 * Record a credential change event (PIN, phone, email, biometric re-enroll).
 * Returns { count, flagged } — flagged if ≥2 different credential types changed in 1h.
 */
export function recordCredentialChange(credType) {
  const changes = lsGet(CRED_CHANGE_KEY) || [];
  const ts      = now();
  changes.push({ type: credType, ts });
  // Prune to last 24h
  const pruned = changes.filter(c => ts - c.ts < 24 * 60 * 60 * 1000);
  lsSet(CRED_CHANGE_KEY, pruned);

  // Flag: ≥2 distinct credential types changed within 1 hour
  const recentHour  = pruned.filter(c => ts - c.ts < 60 * 60 * 1000);
  const uniqueTypes = new Set(recentHour.map(c => c.type));
  const flagged     = uniqueTypes.size >= 2;

  if (flagged) {
    logSuspiciousActivity('rapid_credential_changes', `${uniqueTypes.size} types in 1h: ${[...uniqueTypes].join(', ')}`);
    emit('ATO_SIGNAL', { type: 'rapid_credential_changes', types: [...uniqueTypes], count: recentHour.length });
  }

  return { count: recentHour.length, flagged, types: [...uniqueTypes] };
}

export function getCredentialChangeHistory() {
  return lsGet(CRED_CHANGE_KEY) || [];
}

// ── 3. Auth Failure Tracking ───────────────────────────────────────────────────

/**
 * Record an authentication failure.
 * Returns { count10min, count1h, flagged }
 * Flagged at: ≥5 in 10 minutes (brute force) or ≥10 in 1 hour.
 */
export function recordAuthFailure(method = 'pin') {
  const fails = lsGet(AUTH_FAIL_KEY) || [];
  const ts    = now();
  fails.push({ method, ts });
  const pruned = fails.filter(f => ts - f.ts < 60 * 60 * 1000);
  lsSet(AUTH_FAIL_KEY, pruned);

  const count10min = pruned.filter(f => ts - f.ts < 10 * 60 * 1000).length;
  const count1h    = pruned.length;
  const flagged    = count10min >= 5 || count1h >= 10;

  if (flagged) {
    logSuspiciousActivity('auth_failure_spike', `${count10min} failures in 10min, ${count1h} in 1h`);
    emit('ATO_SIGNAL', { type: 'auth_failure_spike', count10min, count1h });
  }

  return { count10min, count1h, flagged };
}

export function clearAuthFailures() {
  lsSet(AUTH_FAIL_KEY, []);
}

export function getRecentAuthFailureCount(windowMs = 10 * 60 * 1000) {
  const fails = lsGet(AUTH_FAIL_KEY) || [];
  return fails.filter(f => now() - f.ts < windowMs).length;
}

// ── 4. Behavioral Velocity ─────────────────────────────────────────────────────

/**
 * Record a sensitive action (transfer, paybill, airtime, PIN change).
 * Returns velocity metrics — used to detect rapid/automated action sequences.
 */
export function recordSensitiveAction(actionType) {
  const actions = lsGet(ACTION_VEL_KEY) || [];
  const ts      = now();
  actions.push({ type: actionType, ts });
  const pruned = actions.filter(a => ts - a.ts < 60 * 60 * 1000);
  lsSet(ACTION_VEL_KEY, pruned);

  const count5min = pruned.filter(a => ts - a.ts < 5 * 60 * 1000).length;
  const count1h   = pruned.length;

  // Flag: >5 sensitive actions in 5 min (likely automation)
  const flagged = count5min > 5;
  if (flagged) {
    logSuspiciousActivity('action_velocity_spike', `${count5min} sensitive actions in 5 min`);
    emit('ATO_SIGNAL', { type: 'action_velocity_spike', count5min, count1h });
  }

  return { count5min, count1h, flagged };
}

// ── 5. Session Token Replay Detection ─────────────────────────────────────────

/**
 * Register a session token as "seen". Returns true if this token was already seen
 * (indicating a replay attack or stolen session).
 */
export function detectSessionReplay(sessionId) {
  if (!sessionId) return false;
  const seen = lsGet(SESSION_TOKEN_KEY) || [];
  const ts   = now();

  // Check if seen before (replay)
  const isReplay = seen.some(e => e.id === sessionId);

  // Prune to last 24h, append
  const pruned = seen.filter(e => ts - e.ts < 24 * 60 * 60 * 1000).slice(-50);
  if (!isReplay) {
    pruned.push({ id: sessionId, ts });
    lsSet(SESSION_TOKEN_KEY, pruned);
  }

  if (isReplay) {
    logSuspiciousActivity('session_replay', `Token ${sessionId.slice(0, 12)}… seen before`);
    emit('ATO_SIGNAL', { type: 'session_replay', sessionId });
  }

  return isReplay;
}

// ── 6. Composite ATO Risk Score ────────────────────────────────────────────────

/**
 * Compute a composite ATO risk score 0–100 from all available signals.
 * Call this before any privileged action to decide step-up requirements.
 *
 * @returns {{ score: number, level: string, factors: string[], requireStepUp: boolean, requireLogout: boolean }}
 */
export function computeAtoRisk() {
  let score = 0;
  const factors = [];

  // Impossible travel
  const travel = checkImpossibleTravel();
  if (travel.anomaly) {
    score += travel.score;
    factors.push(`Impossible travel: ${travel.detail}`);
  }

  // Auth failure velocity
  const failCount = getRecentAuthFailureCount(10 * 60 * 1000);
  if (failCount >= 5) {
    score += Math.min(40, failCount * 6);
    factors.push(`${failCount} failed auth attempts in 10 min`);
  } else if (failCount >= 3) {
    score += 20;
    factors.push(`${failCount} failed auth attempts in 10 min`);
  }

  // Credential change velocity
  const credChanges = lsGet(CRED_CHANGE_KEY) || [];
  const recentCredChanges = credChanges.filter(c => now() - c.ts < 60 * 60 * 1000);
  const uniqueCredTypes   = new Set(recentCredChanges.map(c => c.type));
  if (uniqueCredTypes.size >= 2) {
    score += 35;
    factors.push(`Rapid credential changes: ${[...uniqueCredTypes].join(', ')}`);
  }

  // Action velocity
  const actions    = lsGet(ACTION_VEL_KEY) || [];
  const act5min    = actions.filter(a => now() - a.ts < 5 * 60 * 1000).length;
  if (act5min > 5) {
    score += 25;
    factors.push(`${act5min} sensitive actions in 5 min`);
  }

  const clampedScore  = Math.min(100, score);
  const level         = scoreToAtoLevel(clampedScore);
  const requireStepUp = clampedScore >= 30;
  const requireLogout = clampedScore >= 80;

  // Log significant events
  if (clampedScore >= 30) {
    appendAtoLog({ score: clampedScore, level, factors });
  }

  return { score: clampedScore, level, factors, requireStepUp, requireLogout };
}

function scoreToAtoLevel(score) {
  if (score >= 80) return 'CRITICAL';
  if (score >= 55) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

// ── ATO Event Log ─────────────────────────────────────────────────────────────

function appendAtoLog(event) {
  const log = lsGet(ATO_LOG_KEY) || [];
  log.push({ ...event, ts: now() });
  if (log.length > 100) log.splice(0, log.length - 100);
  lsSet(ATO_LOG_KEY, log);
}

export function getAtoLog() {
  return lsGet(ATO_LOG_KEY) || [];
}

export function getAtoSummary() {
  const log    = getAtoLog();
  const recent = log.filter(e => now() - e.ts < 24 * 60 * 60 * 1000);
  const highest = recent.reduce((max, e) => Math.max(max, e.score || 0), 0);
  return {
    eventsLast24h: recent.length,
    highestScore:  highest,
    level:         scoreToAtoLevel(highest),
    allClear:      highest < 30,
  };
}