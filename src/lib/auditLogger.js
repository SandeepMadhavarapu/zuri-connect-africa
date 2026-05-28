/**
 * Zuri Connect Africa — Security Audit Logger v2
 *
 * Structured, tamper-evident audit log for security-critical events.
 *
 * Event categories:
 *   AUTH       — login, logout, PIN verify, biometric
 *   SESSION    — create, rotate, expire, hard-cap
 *   STEPUP     — challenge issued, passed, failed
 *   RISK       — score computed, level escalated
 *   ATO        — account takeover signals detected
 *   ROUTE      — protected route access attempt
 *   DEVICE     — trust granted, revoked, anomaly
 *   TXACTION   — financial action initiated with risk context
 *
 * Each entry is chained: entry.prevHash links to the hash of the previous entry,
 * allowing server-side reconciliation to detect log tampering.
 */

const LOG_KEY     = 'zuri_audit_log_v2';
const MAX_ENTRIES = 500;

// ── Backward-compat constants ─────────────────────────────────────────────────

export const SEVERITY = {
  CRITICAL: 'CRITICAL',
  HIGH:     'HIGH',
  MEDIUM:   'MEDIUM',
  LOW:      'LOW',
};

export const AUDIT_ACTIONS = {
  AUTH_FAILED:              'auth_failure',
  AUTH_SUCCESS:             'auth_success',
  RECONCILIATION_EXECUTED:  'reconciliation_executed',
  STEPUP_ISSUED:            'stepup_issued',
  STEPUP_PASSED:            'stepup_passed',
  ROUTE_ACCESSED:           'route_access_attempt',
  SESSION_EXPIRED:          'session_expire',
  ATO_SIGNAL:               'ato_signal',
};

// ── Simple non-crypto chain hash ──────────────────────────────────────────────
function chainHash(entry) {
  const str = JSON.stringify({
    ts:       entry.ts,
    category: entry.category,
    event:    entry.event,
    userId:   entry.userId,
    prevHash: entry.prevHash,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── Core storage ──────────────────────────────────────────────────────────────

/** Read raw v2 log entries from localStorage. */
function readRawLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; }
}

function writeRawLog(log) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch {}
}

// ── Write buffer ──────────────────────────────────────────────────────────────

let _pendingFlush = null;
let _buffer       = [];

function flushBuffer() {
  if (_buffer.length === 0) return;
  const log = readRawLog();
  log.push(..._buffer);
  _buffer = [];
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  writeRawLog(log);
}

// ── Core logger ───────────────────────────────────────────────────────────────

/**
 * Append a structured audit event.
 *
 * @param {string} category   — AUTH | SESSION | STEPUP | RISK | ATO | ROUTE | DEVICE | TXACTION
 * @param {string} event      — machine-readable event name (e.g. 'pin_verify_success')
 * @param {object} details    — arbitrary metadata (sanitised — no PII)
 * @param {string} userId     — current user identifier (email or 'anonymous')
 */
export function logAuditEvent(category, event, details = {}, userId = 'anonymous') {
  const raw      = readRawLog();
  const prevHash = raw.length > 0 ? raw[raw.length - 1].hash : '0000000';

  const entry = {
    id:       `ev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    ts:       Date.now(),
    category,
    event,
    userId,
    details:  sanitiseDetails(details),
    prevHash,
  };
  entry.hash = chainHash(entry);

  _buffer.push(entry);

  if (_pendingFlush) clearTimeout(_pendingFlush);
  _pendingFlush = setTimeout(() => {
    flushBuffer();
    _pendingFlush = null;
  }, 200);

  return entry;
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

/**
 * Get all audit log entries.
 * Accepts an optional ignored argument for backward-compat with callers
 * that previously did `getAuditLog({})`.
 * Returns entries shaped with both v2 fields AND v1 compat fields.
 */
export function getAuditLog(_opts) {
  const raw = readRawLog();
  return raw.map(e => ({
    // v1 compat fields (AdminSecurityDashboard)
    entryId:  e.id,
    epochMs:  e.ts,
    action:   e.event,
    severity: (e.category === 'ATO' || e.category === 'RISK')
      ? SEVERITY.HIGH
      : (e.category === 'AUTH' && e.event === 'auth_failure')
        ? SEVERITY.MEDIUM
        : SEVERITY.LOW,
    // v2 fields (passthrough — these override the compat aliases above if same key)
    ...e,
  }));
}

export function getAuditLogByCategory(category) {
  return getAuditLog().filter(e => e.category === category);
}

export function getRecentAuditEvents(windowMs = 60 * 60 * 1000) {
  const cutoff = Date.now() - windowMs;
  return getAuditLog().filter(e => e.ts > cutoff);
}

// ── Integrity check ───────────────────────────────────────────────────────────

/**
 * Verify the audit log chain integrity.
 * Returns { valid: boolean, brokenAt: number|null }
 */
export function verifyLogIntegrity() {
  const raw = readRawLog();
  for (let i = 1; i < raw.length; i++) {
    const expected = chainHash(raw[i]);
    if (expected !== raw[i].hash) {
      return { valid: false, brokenAt: i, entry: raw[i] };
    }
    if (raw[i].prevHash !== raw[i - 1].hash) {
      return { valid: false, brokenAt: i, reason: 'chain_broken' };
    }
  }
  return { valid: true, brokenAt: null };
}

// ── PII sanitiser ─────────────────────────────────────────────────────────────

function sanitiseDetails(details) {
  if (typeof details !== 'object' || details === null) return {};
  const sanitised = { ...details };
  const sensitiveKeys = ['pin', 'password', 'otp', 'token', 'secret', 'hash', 'biometric'];
  for (const key of sensitiveKeys) {
    if (sanitised[key] !== undefined) sanitised[key] = '[REDACTED]';
  }
  if (sanitised.phone && typeof sanitised.phone === 'string') {
    sanitised.phone = sanitised.phone.slice(0, 4) + '****' + sanitised.phone.slice(-2);
  }
  return sanitised;
}

// ── Convenience wrappers ──────────────────────────────────────────────────────

export const audit = {
  authSuccess:    (method, userId)    => logAuditEvent('AUTH',    'auth_success',        { method },                userId),
  authFailure:    (method, userId)    => logAuditEvent('AUTH',    'auth_failure',         { method },                userId),
  logout:         (reason, userId)    => logAuditEvent('AUTH',    'logout',               { reason },                userId),
  sessionCreate:  (sessionId, userId) => logAuditEvent('SESSION', 'session_create',       { sessionId },             userId),
  sessionExpire:  (reason, userId)    => logAuditEvent('SESSION', 'session_expire',       { reason },                userId),
  sessionRotate:  (reason, userId)    => logAuditEvent('SESSION', 'session_rotate',       { reason },                userId),
  stepUpIssued:   (reason, userId)    => logAuditEvent('STEPUP',  'stepup_issued',        { reason },                userId),
  stepUpPassed:   (userId)            => logAuditEvent('STEPUP',  'stepup_passed',        {},                        userId),
  stepUpFailed:   (userId)            => logAuditEvent('STEPUP',  'stepup_failed',        {},                        userId),
  riskEscalation: (level, score, factors, userId) =>
    logAuditEvent('RISK',     'risk_escalation',       { level, score, factors },         userId),
  atoSignal:      (type, detail, userId) =>
    logAuditEvent('ATO',      'ato_signal',             { type, detail },                  userId),
  routeAccess:    (path, allowed, userId) =>
    logAuditEvent('ROUTE',    'route_access_attempt',   { path, allowed },                userId),
  deviceTrust:    (action, fpId, userId) =>
    logAuditEvent('DEVICE',   'device_trust_change',    { action, fpId },                 userId),
  txAction:       (type, amount, riskLevel, userId) =>
    logAuditEvent('TXACTION', 'transaction_initiated',  { type, amount, riskLevel },      userId),
  paymentInitiated: (userId, txRef, details = {}) =>
    logAuditEvent('TXACTION', 'payment_initiated',      { txRef, ...details },            userId),
  fraudEscalated: (userId, txRef, details = {}) =>
    logAuditEvent('RISK',     'fraud_escalated',        { txRef, ...details },            userId),
  reconciliationRun: (userId, txRef, details = {}) =>
    logAuditEvent('TXACTION', 'reconciliation_executed',{ txRef, ...details },            userId),
};
