/**
 * Zuri Connect Africa — Session Security Manager v3
 *
 * Architecture:
 *   - Sliding expiration: every user interaction resets the inactivity clock
 *   - Hard session cap: absolute max session age (8h), regardless of activity
 *   - Session rotation: new session token generated on privilege elevation
 *   - Cross-tab sync: BroadcastChannel notifies other tabs of lock/logout
 *   - Background re-auth: visibility change triggers immediate stale check
 *   - Secure wipe: clearSession removes all auth-related storage
 *   - CSRF token: per-session CSRF nonce for state-mutating actions
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const INACTIVITY_TIMEOUT_MS  = 5 * 60 * 1000;   // 5 min sliding window
const WARNING_BEFORE_MS      = 60 * 1000;        // warn 1 min before lock
const HARD_SESSION_CAP_MS    = 8 * 60 * 60 * 1000; // 8h absolute maximum
const SESSION_KEY            = 'zuri_session_v3';
const FINGERPRINT_KEY        = 'zuri_device_fp';
const CSRF_KEY               = 'zuri_csrf_token';
const ROTATION_LOG_KEY       = 'zuri_session_rotations';
const CHANNEL_NAME           = 'zuri_session_sync';
const REFRESH_TOKEN_KEY      = 'zuri_refresh_tokens_v1';
const REVOKED_TOKEN_KEY      = 'zuri_revoked_tokens_v1';
const ACTIVE_SESSION_KEY     = 'zuri_active_sessions_v1';
const SESSION_HEARTBEAT_KEY  = 'zuri_session_heartbeats_v1';
const REFRESH_TOKEN_TTL_MS   = 12 * 60 * 60 * 1000; // 12h restore window

// ── Module-level state ────────────────────────────────────────────────────────

let inactivityTimer    = null;
let warningTimer       = null;
let hardCapTimer       = null;
let onLockCallback     = null;
let onWarnCallback     = null;
let visibilityHandler  = null;
let broadcastChannel   = null;
let activityListeners  = [];

// ── Crypto helpers ────────────────────────────────────────────────────────────

function genToken(prefix = 'tok') {
  try {
    return `${prefix}_${crypto.randomUUID()}`;
  } catch {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
}

function simpleHash(value) {
  const raw = String(value || '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function readLocalJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); } catch { return fallback; }
}

function writeLocalJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function tokenHash(token, deviceFp) {
  return simpleHash(`${token}|${deviceFp}|zuri-session-binding`);
}

function issueRefreshToken(sessionId, deviceFp) {
  const token = genToken('refresh');
  const tokenId = simpleHash(token);
  const record = {
    tokenId,
    tokenHash: tokenHash(token, deviceFp),
    sessionId,
    deviceFp,
    issuedAt: Date.now(),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
    rotatedAt: null,
    revokedAt: null,
  };
  const store = readLocalJson(REFRESH_TOKEN_KEY, {});
  store[tokenId] = record;
  writeLocalJson(REFRESH_TOKEN_KEY, store);
  return { token, tokenId, record };
}

function isTokenRevoked(tokenId) {
  const revoked = readLocalJson(REVOKED_TOKEN_KEY, {});
  return Boolean(revoked[tokenId]);
}

function registerActiveSession(session) {
  const registry = readLocalJson(ACTIVE_SESSION_KEY, {});
  const userKey = session.userId || 'local_user';
  registry[userKey] = registry[userKey] || [];
  registry[userKey] = registry[userKey]
    .filter(item => item.expiresAt > Date.now() && item.sessionId !== session.id)
    .slice(-4);
  registry[userKey].push({
    sessionId: session.id,
    deviceFp: session.deviceFp,
    createdAt: session.createdAt,
    lastActive: session.lastActive,
    expiresAt: session.hardCapAt,
  });
  writeLocalJson(ACTIVE_SESSION_KEY, registry);
}

function recordSessionHeartbeat(session) {
  if (!session?.id) return;
  const heartbeats = readLocalJson(SESSION_HEARTBEAT_KEY, {});
  heartbeats[session.id] = {
    sessionId: session.id,
    deviceFp: session.deviceFp,
    lastActive: session.lastActive || Date.now(),
    recordedAt: Date.now(),
  };
  writeLocalJson(SESSION_HEARTBEAT_KEY, heartbeats);
}

// ── CSRF Token ─────────────────────────────────────────────────────────────────

/**
 * Get or create a per-session CSRF nonce.
 * Regenerated on every session rotation.
 */
export function getCsrfToken() {
  let token = sessionStorage.getItem(CSRF_KEY);
  if (!token) {
    token = genToken('csrf');
    sessionStorage.setItem(CSRF_KEY, token);
  }
  return token;
}

export function rotateCsrfToken() {
  const token = genToken('csrf');
  sessionStorage.setItem(CSRF_KEY, token);
  return token;
}

export function validateCsrfToken(token) {
  const expected = sessionStorage.getItem(CSRF_KEY);
  if (!expected) return { valid: false, reason: 'missing_session_csrf' };
  return {
    valid: expected === token,
    reason: expected === token ? 'ok' : 'csrf_mismatch',
  };
}

// ── Device Fingerprint ────────────────────────────────────────────────────────

export function generateDeviceFingerprint() {
  let timeZone = 'unknown';
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {}
  const components = [
    navigator.userAgent,
    navigator.language,
    navigator.platform || 'unknown',
    navigator.hardwareConcurrency || 'unknown',
    screen.colorDepth,
    timeZone,
  ];
  const raw = components.join('|');
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const char = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

export function getOrCreateDeviceFingerprint() {
  let fp = localStorage.getItem(FINGERPRINT_KEY);
  if (!fp) {
    fp = generateDeviceFingerprint();
    localStorage.setItem(FINGERPRINT_KEY, fp);
  }
  return fp;
}

export function isDeviceTrusted() {
  const stored  = localStorage.getItem(FINGERPRINT_KEY);
  if (!stored) return false;
  return stored === generateDeviceFingerprint();
}

// ── Session State ─────────────────────────────────────────────────────────────

export function createSession() {
  const now = Date.now();
  const deviceFp = getOrCreateDeviceFingerprint();
  const session = {
    id:            genToken('sess'),
    createdAt:     now,
    lastActive:    now,
    hardCapAt:     now + HARD_SESSION_CAP_MS,
    deviceFp,
    authenticated: false,
    csrfToken:     rotateCsrfToken(),
    rotationCount: 0,
    refreshTokenId: null,
  };
  const refresh = issueRefreshToken(session.id, deviceFp);
  session.refreshTokenId = refresh.tokenId;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  registerActiveSession(session);
  recordSessionHeartbeat(session);
  return session;
}

export function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

export function markSessionAuthenticated() {
  const session = getSession() || createSession();
  session.authenticated = true;
  session.lastActive    = Date.now();
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  registerActiveSession(session);
  recordSessionHeartbeat(session);
}

export function updateSessionActivity() {
  const session = getSession();
  if (!session) return;
  session.lastActive = Date.now();
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  registerActiveSession(session);
  recordSessionHeartbeat(session);
}

/**
 * Rotate the session token on privilege elevation (e.g. after step-up auth).
 * Issues a new session ID and CSRF token; preserves creation time for hard cap.
 */
export function rotateSession(reason = 'privilege_elevation') {
  const session = getSession();
  if (!session) return createSession();

  const prev = session.id;
  const prevRefreshTokenId = session.refreshTokenId;
  session.id            = genToken('sess');
  session.lastActive    = Date.now();
  session.rotationCount = (session.rotationCount || 0) + 1;
  session.csrfToken     = rotateCsrfToken();
  const refresh = issueRefreshToken(session.id, session.deviceFp);
  session.refreshTokenId = refresh.tokenId;

  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  registerActiveSession(session);
  recordSessionHeartbeat(session);
  if (prevRefreshTokenId) revokeRefreshToken(prevRefreshTokenId, reason);

  // Log rotation
  try {
    const log = JSON.parse(localStorage.getItem(ROTATION_LOG_KEY) || '[]');
    log.push({ from: prev, to: session.id, reason, ts: Date.now() });
    if (log.length > 20) log.splice(0, log.length - 20);
    localStorage.setItem(ROTATION_LOG_KEY, JSON.stringify(log));
  } catch {}

  return session;
}

/**
 * Wipe all auth-related storage keys — called on logout or CRITICAL risk event.
 */
export function clearSession() {
  const session = getSession();
  if (session?.refreshTokenId) revokeRefreshToken(session.refreshTokenId, 'session_clear');
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(CSRF_KEY);
  // Do NOT remove device fingerprint — needed for re-auth trust checks
}

export function revokeRefreshToken(tokenId, reason = 'revoked') {
  if (!tokenId) return null;
  const store = readLocalJson(REFRESH_TOKEN_KEY, {});
  const revoked = readLocalJson(REVOKED_TOKEN_KEY, {});
  if (store[tokenId]) {
    store[tokenId] = { ...store[tokenId], revokedAt: Date.now(), revokeReason: reason };
  }
  revoked[tokenId] = { tokenId, reason, revokedAt: Date.now() };
  writeLocalJson(REFRESH_TOKEN_KEY, store);
  writeLocalJson(REVOKED_TOKEN_KEY, revoked);
  return revoked[tokenId];
}

export function revokeCurrentSession(reason = 'revoked') {
  const session = getSession();
  if (!session) return null;
  return revokeRefreshToken(session.refreshTokenId, reason);
}

/**
 * Full secure wipe: clears session + sensitive cached data.
 * Use for logout or account takeover mitigation.
 */
export function secureWipe() {
  clearSession();
  // Broadcast logout to all open tabs
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.postMessage({ type: 'LOGOUT' });
    ch.close();
  } catch {}
}

// ── Session Validation ────────────────────────────────────────────────────────

/**
 * Validate the current session:
 *   - Existence
 *   - Hard cap expiry
 *   - Device fingerprint match
 * Returns { valid: boolean, reason: string }
 */
export function detectConcurrentSession(userId = 'local_user') {
  const session = getSession();
  const registry = readLocalJson(ACTIVE_SESSION_KEY, {});
  const active = (registry[userId] || [])
    .filter(item => item.expiresAt > Date.now())
    .filter(item => item.sessionId !== session?.id);

  return {
    concurrent: active.some(item => item.deviceFp !== session?.deviceFp),
    activeSessionCount: active.length + (session ? 1 : 0),
    otherSessions: active,
  };
}

export function evaluateSessionAnomaly() {
  const session = getSession();
  const validation = validateSession();
  const concurrent = detectConcurrentSession();
  const suspiciousCount = getRecentSuspiciousCount();
  let score = 0;
  const signals = [];

  if (!validation.valid) {
    score += 35;
    signals.push(validation.reason);
  }
  if (concurrent.concurrent) {
    score += 30;
    signals.push('concurrent_session_other_device');
  }
  if (session?.rotationCount > 5) {
    score += 15;
    signals.push('high_session_rotation_count');
  }
  if (suspiciousCount > 2) {
    score += Math.min(25, suspiciousCount * 5);
    signals.push('recent_suspicious_activity');
  }

  return {
    score: Math.min(100, score),
    level: score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 20 ? 'medium' : 'low',
    signals,
    concurrent,
  };
}

export function restoreSessionSafely() {
  const session = getSession();
  if (!session) return null;
  const validation = validateSession();
  if (!validation.valid) {
    clearSession();
    return null;
  }
  updateSessionActivity();
  return getSession();
}

export function validateSession() {
  const session = getSession();
  if (!session) return { valid: false, reason: 'no_session' };

  const now = Date.now();

  // Hard cap check
  if (session.hardCapAt && now > session.hardCapAt) {
    return { valid: false, reason: 'hard_cap_expired' };
  }

  // Inactivity check
  const idleMs = now - (session.lastActive || now);
  if (idleMs > INACTIVITY_TIMEOUT_MS) {
    return { valid: false, reason: 'inactivity_timeout' };
  }

  // Device fingerprint check — mismatch is a hard invalidation signal
  const currentFp = getOrCreateDeviceFingerprint();
  if (session.deviceFp && session.deviceFp !== currentFp) {
    return { valid: false, reason: 'device_fingerprint_mismatch' };
  }

  if (session.refreshTokenId && isTokenRevoked(session.refreshTokenId)) {
    return { valid: false, reason: 'refresh_token_revoked' };
  }

  const refreshStore = readLocalJson(REFRESH_TOKEN_KEY, {});
  const refreshRecord = refreshStore[session.refreshTokenId];
  if (session.refreshTokenId && (!refreshRecord || refreshRecord.expiresAt < now || refreshRecord.deviceFp !== session.deviceFp)) {
    return { valid: false, reason: 'refresh_token_invalid' };
  }

  return { valid: true, reason: 'ok' };
}

// ── Inactivity Timer ──────────────────────────────────────────────────────────

/**
 * Start the inactivity watchdog with sliding expiration + hard cap.
 * @param {() => void} onLock   — called when app should lock
 * @param {() => void} onWarn   — called 60s before lock
 */
export function startInactivityWatcher(onLock, onWarn) {
  onLockCallback = onLock;
  onWarnCallback = onWarn;

  // Set up cross-tab sync
  try {
    broadcastChannel = new BroadcastChannel(CHANNEL_NAME);
    broadcastChannel.onmessage = (e) => {
      if (e.data?.type === 'LOGOUT' || e.data?.type === 'LOCK') {
        // Another tab triggered a lock/logout — mirror it here
        clearTimeout(inactivityTimer);
        clearTimeout(warningTimer);
        clearTimeout(hardCapTimer);
        onLockCallback?.();
      } else if (e.data?.type === 'ACTIVITY') {
        // Another tab had activity — reset our timers too (sliding window)
        resetTimers(false); // don't re-broadcast to avoid loop
      }
    };
  } catch {}

  const resetTimers = (broadcast = true) => {
    clearTimeout(inactivityTimer);
    clearTimeout(warningTimer);
    updateSessionActivity();

    if (broadcast) {
      try { broadcastChannel?.postMessage({ type: 'ACTIVITY' }); } catch {}
    }

    warningTimer = setTimeout(() => {
      onWarnCallback?.();
    }, INACTIVITY_TIMEOUT_MS - WARNING_BEFORE_MS);

    inactivityTimer = setTimeout(() => {
      onLockCallback?.();
      try { broadcastChannel?.postMessage({ type: 'LOCK' }); } catch {}
    }, INACTIVITY_TIMEOUT_MS);
  };

  // Hard session cap — fires regardless of activity
  const session = getSession();
  if (session?.hardCapAt) {
    const remaining = session.hardCapAt - Date.now();
    if (remaining > 0) {
      hardCapTimer = setTimeout(() => {
        clearTimeout(inactivityTimer);
        clearTimeout(warningTimer);
        onLockCallback?.();
        try { broadcastChannel?.postMessage({ type: 'LOGOUT', reason: 'hard_cap' }); } catch {}
      }, remaining);
    }
  }

  // Activity event listeners
  const events = ['mousemove', 'keydown', 'touchstart', 'click', 'scroll', 'pointerdown'];
  const handler = () => resetTimers(true);
  events.forEach(e => window.addEventListener(e, handler, { passive: true }));
  activityListeners = events.map(e => ({ event: e, handler }));

  // Background tab: check stale session on return
  visibilityHandler = () => {
    if (document.visibilityState === 'visible') {
      const validation = validateSession();
      if (!validation.valid) {
        clearTimeout(inactivityTimer);
        clearTimeout(warningTimer);
        onLockCallback?.();
        return;
      }
      resetTimers(false);
    }
  };
  document.addEventListener('visibilitychange', visibilityHandler);

  resetTimers(false);

  return () => {
    clearTimeout(inactivityTimer);
    clearTimeout(warningTimer);
    clearTimeout(hardCapTimer);
    activityListeners.forEach(({ event, handler: h }) => window.removeEventListener(event, h));
    activityListeners = [];
    if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
    try { broadcastChannel?.close(); broadcastChannel = null; } catch {}
  };
}

export function stopInactivityWatcher() {
  clearTimeout(inactivityTimer);
  clearTimeout(warningTimer);
  clearTimeout(hardCapTimer);
  activityListeners.forEach(({ event, handler: h }) => window.removeEventListener(event, h));
  activityListeners = [];
  if (visibilityHandler) {
    document.removeEventListener('visibilitychange', visibilityHandler);
    visibilityHandler = null;
  }
  try { broadcastChannel?.close(); broadcastChannel = null; } catch {}
}

// ── Suspicious Activity Log ────────────────────────────────────────────────────

const SUSPICIOUS_LOG_KEY = 'zuri_suspicious_log';

export function logSuspiciousActivity(type, detail) {
  const log = JSON.parse(localStorage.getItem(SUSPICIOUS_LOG_KEY) || '[]');
  log.push({ type, detail, timestamp: Date.now() });
  if (log.length > 100) log.splice(0, log.length - 100);
  localStorage.setItem(SUSPICIOUS_LOG_KEY, JSON.stringify(log));
}

export function getSuspiciousActivityLog() {
  return JSON.parse(localStorage.getItem(SUSPICIOUS_LOG_KEY) || '[]');
}

export function getRecentSuspiciousCount(windowMs = 10 * 60 * 1000) {
  const log    = getSuspiciousActivityLog();
  const cutoff = Date.now() - windowMs;
  return log.filter(e => e.timestamp >= cutoff).length;
}
