/**
 * Backend-style session control facade.
 * Wraps the browser demo session manager with production security semantics.
 */

import {
  createSession,
  getSession,
  rotateSession,
  validateSession,
  revokeCurrentSession,
  validateCsrfToken,
  detectConcurrentSession,
  evaluateSessionAnomaly,
  restoreSessionSafely,
  secureWipe,
} from '@/lib/sessionSecurity';
import { evaluateDeviceRisk } from '@/lib/deviceTrust';

export function startSecureSession({ authenticated = false } = {}) {
  const session = createSession();
  if (authenticated) {
    session.authenticated = true;
    sessionStorage.setItem('zuri_session_v3', JSON.stringify(session));
  }
  return session;
}

export function rotateRefreshSession(reason = 'refresh_rotation') {
  return rotateSession(reason);
}

export function revokeSession(reason = 'manual_revocation') {
  return revokeCurrentSession(reason);
}

export function validateSessionRequest({ csrfToken, riskyAction = false, deviceContext = {} } = {}) {
  const sessionValidation = validateSession();
  const csrfValidation = csrfToken ? validateCsrfToken(csrfToken) : { valid: !riskyAction, reason: riskyAction ? 'missing_csrf' : 'not_required' };
  const concurrent = detectConcurrentSession();
  const anomaly = evaluateSessionAnomaly();
  const deviceRisk = evaluateDeviceRisk(deviceContext);

  const requiresBiometric = riskyAction &&
    (deviceRisk.score >= 45 || anomaly.score >= 35 || concurrent.concurrent);

  return {
    valid: sessionValidation.valid && csrfValidation.valid && !concurrent.concurrent,
    session: getSession(),
    sessionValidation,
    csrfValidation,
    concurrent,
    anomaly,
    deviceRisk,
    requiresBiometric,
  };
}

export function restoreOrCreateSession() {
  return restoreSessionSafely() || createSession();
}

export function secureLogout(reason = 'secure_logout') {
  revokeCurrentSession(reason);
  secureWipe();
  return { success: true, reason };
}
