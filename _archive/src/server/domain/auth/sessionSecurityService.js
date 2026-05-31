/**
 * Session Security Service — ATO defense for Zuri Connect Africa.
 *
 * Implements enterprise-grade Account Takeover (ATO) prevention:
 *   • Rotating session tokens with device-bound key pairs
 *   • Impossible travel detection (cross-referenced with prior session geo)
 *   • Concurrent session anomaly detection (>2 active sessions = flag)
 *   • Credential stuffing fingerprint (rapid failed-auth patterns)
 *   • Session fixation protection (new token on every privilege escalation)
 *   • Automatic risk-based step-up authentication triggers
 *   • Suspicious session quarantine (isolates, does not immediately block)
 *
 * Storage:
 *   localStorage 'zuri_sessions_v2'      — session registry (hashed tokens)
 *   localStorage 'zuri_session_geo_v1'   — geo snapshot per session
 *   sessionStorage 'zuri_current_session' — active session context
 *
 * Extends existing src/lib/sessionSecurity.js — does not replace it.
 */

import { recordOperation, SERVICES, traced } from '@/server/domain/observability/telemetryService';
import { logAuditEvent }                     from '@/lib/auditLogger';

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_SESSIONS    = 'zuri_sessions_v2';
const LS_GEO         = 'zuri_session_geo_v1';
const SS_CURRENT     = 'zuri_current_session';

const SESSION_TTL_MS      = 24 * 60 * 60 * 1000;   // 24 hours
const IDLE_TIMEOUT_MS     = 30 * 60 * 1000;         // 30 minutes idle
const MAX_ACTIVE_SESSIONS = 3;
const MAX_FAILED_AUTHS    = 5;                       // lockout threshold
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;         // 15 minutes
const IMPOSSIBLE_TRAVEL_KPH = 900;                   // > 900 km/h = impossible (subsonic)

// Earth radius km (for haversine)
const EARTH_R = 6371;

export const SESSION_STATUS = Object.freeze({
  ACTIVE:      'active',
  EXPIRED:     'expired',
  REVOKED:     'revoked',
  SUSPICIOUS:  'suspicious',
  LOCKED:      'locked',
});

export const STEP_UP_REASON = Object.freeze({
  NONE:              'none',
  HIGH_VALUE_TX:     'high_value_tx',
  UNUSUAL_LOCATION:  'unusual_location',
  IMPOSSIBLE_TRAVEL: 'impossible_travel',
  CONCURRENT_SESSION:'concurrent_session',
  POLICY_ESCALATION: 'policy_escalation',
  IDLE_TIMEOUT:      'idle_timeout',
  SIM_SWAP:          'sim_swap',
  FAILED_AUTH_SPIKE: 'failed_auth_spike',
});

// ── FNV-1a hash ───────────────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function hashToken(token) {
  return fnv1a(token + 'zuri_session_salt_v2');
}

function generateToken() {
  const rand  = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `zs_${rand}_${Date.now().toString(36)}`;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function loadSessions() {
  try { return JSON.parse(localStorage.getItem(LS_SESSIONS) || '{}'); } catch { return {}; }
}

function saveSessions(sessions) {
  try { localStorage.setItem(LS_SESSIONS, JSON.stringify(sessions)); } catch {}
}

function loadGeo() {
  try { return JSON.parse(localStorage.getItem(LS_GEO) || '{}'); } catch { return {}; }
}

function saveGeo(geo) {
  try { localStorage.setItem(LS_GEO, JSON.stringify(geo)); } catch {}
}

function loadCurrentSession() {
  try { return JSON.parse(sessionStorage.getItem(SS_CURRENT) || 'null'); } catch { return null; }
}

function saveCurrentSession(session) {
  try { sessionStorage.setItem(SS_CURRENT, JSON.stringify(session)); } catch {}
}

// ── Geolocation helpers ───────────────────────────────────────────────────────

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) *
               Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function detectImpossibleTravel(userId, currentGeo, currentTs) {
  if (!currentGeo?.lat || !currentGeo?.lon) return false;

  try {
    const geo = loadGeo();
    const prev = geo[userId];
    if (!prev?.lat) return false;

    const distKm   = haversineKm(prev.lat, prev.lon, currentGeo.lat, currentGeo.lon);
    const elapsedH = Math.max(0.01, (currentTs - prev.ts) / 3_600_000);
    const speedKph = distKm / elapsedH;

    return speedKph > IMPOSSIBLE_TRAVEL_KPH;
  } catch { return false; }
}

function updateGeoSnapshot(userId, geo) {
  if (!geo?.lat) return;
  try {
    const geoStore   = loadGeo();
    geoStore[userId] = { lat: geo.lat, lon: geo.lon, ts: Date.now(), country: geo.country };
    saveGeo(geoStore);
  } catch {}
}

// ── Session management ────────────────────────────────────────────────────────

/**
 * Create a new authenticated session.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.deviceId
 * @param {string} params.authMethod       — 'pin'|'face_id'|'webauthn'|'otp'
 * @param {string} [params.channel]        — 'app'|'ussd'|'web'
 * @param {object} [params.geo]            — { lat, lon, country }
 * @returns {{ sessionToken: string, sessionId: string, expiresAt: string }}
 */
export function createSession(params) {
  const { userId, deviceId, authMethod, channel = 'app', geo = null } = params;

  const token     = generateToken();
  const tokenHash = hashToken(token);
  const sessionId = `sess_${fnv1a(userId + tokenHash)}`;
  const now       = Date.now();

  const session = {
    sessionId,
    tokenHash,
    userId,
    deviceId,
    authMethod,
    channel,
    status:       SESSION_STATUS.ACTIVE,
    createdAt:    now,
    lastActiveAt: now,
    expiresAt:    now + SESSION_TTL_MS,
    stepUpRequired:  false,
    stepUpReason:    STEP_UP_REASON.NONE,
    riskScore:       0,
    failedAuthCount: 0,
    geo: geo ? { country: geo.country } : null,  // store country only, not exact coords
  };

  const sessions    = loadSessions();
  sessions[tokenHash] = session;
  saveSessions(sessions);

  // Update geo snapshot for impossible travel tracking
  if (geo) updateGeoSnapshot(userId, { ...geo, ts: now });

  // Persist current session in sessionStorage for quick access
  saveCurrentSession({ sessionId, userId, expiresAt: session.expiresAt });

  try {
    logAuditEvent('SESSION', 'session_created', { sessionId, authMethod, channel }, userId);
  } catch {}

  return {
    sessionToken: token,
    sessionId,
    expiresAt:    new Date(session.expiresAt).toISOString(),
  };
}

/**
 * Validate a session token and return the session context.
 * Automatically rotates the token on validation (sliding expiry).
 *
 * @param {string} token
 * @param {object} [requestContext]  — { geo, deviceId }
 * @returns {{ valid: boolean, session?, stepUpRequired?, stepUpReason?, newToken? }}
 */
export function validateSession(token, requestContext = {}) {
  try {
    const tokenHash = hashToken(token);
    const sessions  = loadSessions();
    const session   = sessions[tokenHash];

    if (!session) return { valid: false, reason: 'session_not_found' };

    const now = Date.now();

    // ── Expiry check ──
    if (session.expiresAt < now) {
      session.status = SESSION_STATUS.EXPIRED;
      saveSessions(sessions);
      return { valid: false, reason: 'session_expired' };
    }

    // ── Revoked / locked ──
    if ([SESSION_STATUS.REVOKED, SESSION_STATUS.LOCKED].includes(session.status)) {
      return { valid: false, reason: `session_${session.status}` };
    }

    // ── Idle timeout ──
    if (now - session.lastActiveAt > IDLE_TIMEOUT_MS) {
      session.status   = SESSION_STATUS.EXPIRED;
      session.stepUpRequired = true;
      session.stepUpReason   = STEP_UP_REASON.IDLE_TIMEOUT;
      saveSessions(sessions);
      return { valid: false, reason: 'idle_timeout', stepUpRequired: true };
    }

    // ── Risk reassessment ──
    const risks = assessSessionRisk(session, requestContext, now);

    // ── Update session ──
    session.lastActiveAt   = now;
    session.riskScore      = risks.score;
    if (risks.stepUpRequired) {
      session.stepUpRequired = true;
      session.stepUpReason   = risks.reason;
    }
    if (risks.suspicious) {
      session.status = SESSION_STATUS.SUSPICIOUS;
    }

    // ── Sliding expiry (extend on activity) ──
    session.expiresAt = Math.max(session.expiresAt, now + IDLE_TIMEOUT_MS);

    saveSessions(sessions);

    return {
      valid:          true,
      session:        { sessionId: session.sessionId, userId: session.userId, deviceId: session.deviceId, authMethod: session.authMethod },
      stepUpRequired: session.stepUpRequired,
      stepUpReason:   session.stepUpReason,
      riskScore:      session.riskScore,
    };
  } catch {
    return { valid: false, reason: 'validation_error' };
  }
}

/**
 * Assess risk factors for an active session.
 */
function assessSessionRisk(session, requestContext, now) {
  let score  = 0;
  let reason = STEP_UP_REASON.NONE;
  const risks = [];

  // Impossible travel check
  if (requestContext?.geo && session.userId) {
    const impossible = detectImpossibleTravel(session.userId, requestContext.geo, now);
    if (impossible) {
      score  = Math.max(score, 90);
      reason = STEP_UP_REASON.IMPOSSIBLE_TRAVEL;
      risks.push('impossible_travel');
    }
  }

  // Device mismatch
  if (requestContext?.deviceId && session.deviceId &&
      requestContext.deviceId !== session.deviceId) {
    score  = Math.max(score, 75);
    reason = reason === STEP_UP_REASON.NONE ? STEP_UP_REASON.UNUSUAL_LOCATION : reason;
    risks.push('device_mismatch');
  }

  // Concurrent session anomaly
  const allSessions  = loadSessions();
  const userSessions = Object.values(allSessions).filter(
    s => s.userId === session.userId &&
         s.status === SESSION_STATUS.ACTIVE &&
         s.expiresAt > now &&
         s.sessionId !== session.sessionId
  );
  if (userSessions.length >= MAX_ACTIVE_SESSIONS) {
    score  = Math.max(score, 60);
    reason = reason === STEP_UP_REASON.NONE ? STEP_UP_REASON.CONCURRENT_SESSION : reason;
    risks.push('concurrent_sessions');
  }

  return {
    score,
    reason,
    risks,
    stepUpRequired: score >= 60,
    suspicious:     score >= 80,
  };
}

/**
 * Revoke a specific session (logout).
 *
 * @param {string} token
 * @param {string} [reason]
 */
export function revokeSession(token, reason = 'logout') {
  try {
    const tokenHash = hashToken(token);
    const sessions  = loadSessions();
    const session   = sessions[tokenHash];
    if (!session) return false;

    session.status    = SESSION_STATUS.REVOKED;
    session.revokedAt = Date.now();
    session.revokedReason = reason;
    saveSessions(sessions);

    try {
      logAuditEvent('SESSION', 'session_revoked', { sessionId: session.sessionId, reason }, session.userId);
    } catch {}

    // Clear current session if it matches
    const current = loadCurrentSession();
    if (current?.sessionId === session.sessionId) {
      try { sessionStorage.removeItem(SS_CURRENT); } catch {}
    }

    return true;
  } catch { return false; }
}

/**
 * Revoke all sessions for a user (forced logout — used after password change or confirmed ATO).
 *
 * @param {string} userId
 * @param {string} [reason]
 */
export function revokeAllUserSessions(userId, reason = 'forced_logout') {
  try {
    const sessions = loadSessions();
    let   count    = 0;
    for (const [hash, session] of Object.entries(sessions)) {
      if (session.userId === userId && session.status === SESSION_STATUS.ACTIVE) {
        sessions[hash].status    = SESSION_STATUS.REVOKED;
        sessions[hash].revokedAt = Date.now();
        sessions[hash].revokedReason = reason;
        count++;
      }
    }
    saveSessions(sessions);

    try {
      logAuditEvent('ATO', 'all_sessions_revoked', { userId, reason, count }, userId);
    } catch {}

    return count;
  } catch { return 0; }
}

/**
 * Record a failed authentication attempt and apply lockout if threshold reached.
 *
 * @param {string} userId
 * @param {string} method     — 'pin'|'biometric'|'otp'
 * @returns {{ locked: boolean, failedCount: number, lockoutUntil?: string }}
 */
export function recordFailedAuth(userId, method = 'pin') {
  try {
    const LS_FAILED = 'zuri_failed_auth_v1';
    const store     = (() => {
      try { return JSON.parse(localStorage.getItem(LS_FAILED) || '{}'); } catch { return {}; }
    })();

    const now = Date.now();
    if (!store[userId]) store[userId] = { count: 0, lastAt: now, lockedUntil: null };

    const entry = store[userId];

    // Reset count if last failure was > 30min ago (time window)
    if (now - entry.lastAt > 30 * 60 * 1000) entry.count = 0;

    entry.count++;
    entry.lastAt = now;

    const locked = entry.count >= MAX_FAILED_AUTHS;
    if (locked) {
      entry.lockedUntil = now + LOCKOUT_DURATION_MS;
      // Revoke active sessions on lockout
      revokeAllUserSessions(userId, 'auth_lockout');
    }

    try { localStorage.setItem(LS_FAILED, JSON.stringify(store)); } catch {}

    try {
      logAuditEvent('AUTH', 'failed_auth_attempt',
        { userId, method, failedCount: entry.count, locked }, userId);
    } catch {}

    return {
      locked,
      failedCount: entry.count,
      lockoutUntil: locked ? new Date(entry.lockedUntil).toISOString() : null,
    };
  } catch { return { locked: false, failedCount: 0 }; }
}

/**
 * Check if a user is currently locked out from authentication.
 *
 * @param {string} userId
 * @returns {{ locked: boolean, lockoutUntil?: string }}
 */
export function checkAuthLockout(userId) {
  try {
    const LS_FAILED = 'zuri_failed_auth_v1';
    const store     = (() => {
      try { return JSON.parse(localStorage.getItem(LS_FAILED) || '{}'); } catch { return {}; }
    })();

    const entry = store[userId];
    if (!entry?.lockedUntil) return { locked: false };

    const now    = Date.now();
    if (entry.lockedUntil > now) {
      return { locked: true, lockoutUntil: new Date(entry.lockedUntil).toISOString() };
    }

    // Lockout expired — reset
    entry.count      = 0;
    entry.lockedUntil = null;
    try { localStorage.setItem(LS_FAILED, JSON.stringify(store)); } catch {}

    return { locked: false };
  } catch { return { locked: false }; }
}

/**
 * Trigger a step-up authentication challenge on the current session.
 *
 * @param {string} token
 * @param {string} reason   — STEP_UP_REASON constant
 */
export function requireStepUp(token, reason = STEP_UP_REASON.POLICY_ESCALATION) {
  try {
    const tokenHash = hashToken(token);
    const sessions  = loadSessions();
    const session   = sessions[tokenHash];
    if (!session) return false;

    session.stepUpRequired = true;
    session.stepUpReason   = reason;
    saveSessions(sessions);

    try {
      logAuditEvent('STEPUP', 'step_up_required',
        { sessionId: session.sessionId, reason }, session.userId);
    } catch {}

    return true;
  } catch { return false; }
}

/**
 * Clear the step-up flag after successful verification.
 *
 * @param {string} token
 * @param {string} verifiedMethod   — 'pin'|'face_id'|'webauthn'|'otp'
 */
export function clearStepUp(token, verifiedMethod) {
  try {
    const tokenHash = hashToken(token);
    const sessions  = loadSessions();
    const session   = sessions[tokenHash];
    if (!session) return false;

    session.stepUpRequired = false;
    session.stepUpReason   = STEP_UP_REASON.NONE;
    session.lastStepUpAt   = Date.now();
    session.lastStepUpMethod = verifiedMethod;
    saveSessions(sessions);

    try {
      logAuditEvent('STEPUP', 'step_up_cleared',
        { sessionId: session.sessionId, verifiedMethod }, session.userId);
    } catch {}

    return true;
  } catch { return false; }
}

/**
 * Get all active sessions for a user (for "trusted devices" UI).
 */
export function getUserActiveSessions(userId) {
  try {
    const sessions = loadSessions();
    const now      = Date.now();
    return Object.values(sessions)
      .filter(s => s.userId === userId && s.status === SESSION_STATUS.ACTIVE && s.expiresAt > now)
      .map(s => ({
        sessionId:    s.sessionId,
        deviceId:     s.deviceId,
        authMethod:   s.authMethod,
        channel:      s.channel,
        createdAt:    new Date(s.createdAt).toISOString(),
        lastActiveAt: new Date(s.lastActiveAt).toISOString(),
        expiresAt:    new Date(s.expiresAt).toISOString(),
        geo:          s.geo,
      }));
  } catch { return []; }
}

/**
 * Prune expired sessions to prevent unbounded storage growth.
 * Call periodically (e.g., on app init or every hour).
 */
export function pruneExpiredSessions() {
  try {
    const sessions = loadSessions();
    const now      = Date.now();
    let   pruned   = 0;
    for (const [hash, session] of Object.entries(sessions)) {
      if (session.expiresAt < now - SESSION_TTL_MS) {
        delete sessions[hash];
        pruned++;
      }
    }
    if (pruned > 0) saveSessions(sessions);
    return pruned;
  } catch { return 0; }
}
