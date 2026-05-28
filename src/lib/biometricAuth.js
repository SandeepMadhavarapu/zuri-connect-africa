/**
 * WebAuthn-based biometric authentication service.
 * Supports Face ID, Touch ID, Windows Hello, Android biometrics.
 *
 * Security model:
 *  - Credentials (public key + signCount) are stored SERVER-SIDE in webauthn_credentials.
 *  - Challenges are generated server-side (single-use, 5-minute TTL) via verify-biometric.
 *  - Full assertion verification (challenge, rpIdHash, origin, flags, signature, signCount)
 *    is performed in the verify-biometric Supabase Edge Function.
 *  - Only a non-sensitive credential_id is stored in localStorage as an enrollment indicator.
 */

const BIOMETRIC_RESTORE_TIMEOUT_MS = 5000;
const BIOMETRIC_ENROLL_TIMEOUT_MS  = 60000;
const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1`;
export const BIOMETRIC_SESSION_REQUIRED_MESSAGE = 'Please sign in again before enabling biometrics.';
export const BIOMETRIC_ENROLLED_FALLBACK_LABEL = 'Enrolled on this device';

/**
 * Build a safe enrollment-date label for the Account/Profile UI.
 * Never returns "Invalid Date". Falls back to BIOMETRIC_ENROLLED_FALLBACK_LABEL
 * when the input is missing, empty, or unparseable.
 *
 * @param {string | number | Date | null | undefined} input
 * @param {{ locales?: string | string[], options?: Intl.DateTimeFormatOptions }} [opts]
 * @returns {string}
 */
export function formatBiometricEnrolledLabel(input, opts = {}) {
  if (input === null || input === undefined || input === '') {
    return BIOMETRIC_ENROLLED_FALLBACK_LABEL;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (!d || Number.isNaN(d.getTime())) {
    return BIOMETRIC_ENROLLED_FALLBACK_LABEL;
  }
  try {
    const formatter = new Intl.DateTimeFormat(
      opts.locales,
      opts.options ?? { year: 'numeric', month: 'short', day: 'numeric' },
    );
    return `Enrolled ${formatter.format(d)}`;
  } catch {
    return BIOMETRIC_ENROLLED_FALLBACK_LABEL;
  }
}
const BIOMETRIC_HTTPS_REQUIRED_MESSAGE = 'Please use HTTPS or localhost for biometric setup.';
const BIOMETRIC_UNSUPPORTED_MESSAGE = 'This device does not support biometric login.';
const BIOMETRIC_ORIGIN_CONFIG_MESSAGE = 'Biometric setup is not configured for this app origin.';
const BIOMETRIC_CANCELLED_MESSAGE = 'Biometric setup was cancelled.';
const BIOMETRIC_ENROLL_UNSUPPORTED_MESSAGE = 'This browser does not support biometric enrollment.';

const WEBAUTHN_CONFIG_ERRORS = new Set([
  'webauthn_app_origin_missing',
  'webauthn_rp_id_missing',
  'webauthn_rp_id_origin_mismatch',
  'webauthn_origin_insecure',
]);

function sanitizeBiometricError(error) {
  const raw = String(error?.message || error || 'unknown');
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/access_token["']?\s*[:=]\s*["']?[^"',\s}]+/gi, 'access_token=[redacted]')
    .replace(/challenge["']?\s*[:=]\s*["']?[A-Za-z0-9_-]+/gi, 'challenge=[redacted]')
    .replace(/attestation[_-]?object["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]+/gi, 'attestation_object=[redacted]')
    .replace(/client[_-]?data["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]+/gi, 'client_data=[redacted]');
}

function mapServerBiometricError(errorCode) {
  if (WEBAUTHN_CONFIG_ERRORS.has(String(errorCode || ''))) {
    return BIOMETRIC_ORIGIN_CONFIG_MESSAGE;
  }
  return null;
}

function safeWebAuthnError(error, fallback) {
  const code = String(error?.code || error?.error || '');
  const mapped = mapServerBiometricError(code);
  if (mapped) return mapped;

  const message = sanitizeBiometricError(error);
  if (/webauthn_app_origin_missing|webauthn_rp_id_missing|webauthn_rp_id_origin_mismatch|webauthn_origin_insecure/i.test(message)) {
    return BIOMETRIC_ORIGIN_CONFIG_MESSAGE;
  }
  if (/webauthn_origin_insecure|securityerror|secure context|https|localhost/i.test(message)) {
    return BIOMETRIC_HTTPS_REQUIRED_MESSAGE;
  }
  if (/not supported|notsupported|unsupported|platformAuthenticator/i.test(message)) {
    return BIOMETRIC_UNSUPPORTED_MESSAGE;
  }
  if (/cancel|abort|notallowed|not allowed/i.test(message)) {
    return BIOMETRIC_CANCELLED_MESSAGE;
  }
  if (/timeout/i.test(message)) {
    return 'Biometric enrollment timed out';
  }
  return fallback;
}

function toSafeBiometricError(error, fallback) {
  return safeWebAuthnError(error, fallback);
}

function withTimeout(promise, label, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), ms)
    ),
  ]);
}

export function isBiometricSupported() {
  try {
    return (
      window.PublicKeyCredential !== undefined &&
      navigator.credentials !== undefined &&
      typeof window.PublicKeyCredential === 'function'
    );
  } catch (e) {
    console.warn('[Biometric] Support check failed:', e);
    return false;
  }
}

export async function getPlatformAuthenticators() {
  try {
    if (!isBiometricSupported()) return false;
    const available = await withTimeout(
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.() ?? Promise.resolve(false),
      'platformAuthenticator',
      BIOMETRIC_RESTORE_TIMEOUT_MS
    );
    return available === true;
  } catch (e) {
    console.warn('[Biometric] Platform authenticator check failed:', e);
    return false;
  }
}

/**
 * Encode raw WebAuthn ArrayBuffer/TypedArray bytes as base64url (URL-safe,
 * no padding) — the canonical wire format used by the verify-biometric
 * Edge Function for credential_id, public_key_spki, client_data_json,
 * attestation_object, authenticator_data, and signature.
 */
function arrayBufferToBase64Url(buffer) {
  if (!buffer) return '';
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64 OR base64url string into a Uint8Array. Tolerates both formats
 * so legacy credential_ids cached in localStorage (originally written as
 * standard base64) continue to work after this fix.
 */
function base64AnyToUint8Array(input) {
  const raw = String(input || '');
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = padLen ? normalized + '='.repeat(padLen) : normalized;
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64urlToUint8Array(base64url) {
  return base64AnyToUint8Array(base64url);
}

function base64ToArrayBuffer(base64) {
  return base64AnyToUint8Array(base64).buffer;
}

async function extractPublicKeySpki(credential) {
  const raw = credential?.response?.getPublicKey?.();
  if (!raw) return null;

  if (typeof CryptoKey !== 'undefined' && raw instanceof CryptoKey) {
    const spkiBuffer = await crypto.subtle.exportKey('spki', raw);
    return arrayBufferToBase64Url(spkiBuffer);
  }
  if (raw instanceof ArrayBuffer) {
    return arrayBufferToBase64Url(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return arrayBufferToBase64Url(raw);
  }
  return null;
}

async function fetchVerifyBiometric(accessToken, payload) {
  return fetch(`${FUNCTIONS_BASE}/verify-biometric`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
}

// ── Enrollment ────────────────────────────────────────────────────────────────

/**
 * Register a biometric credential.
 * The public key is stored in the server-side webauthn_credentials table.
 * Only the credential_id (non-sensitive) is cached in localStorage.
 *
 * @param {string} userId
 * @param {string} userName
 * @param {string} accessToken  — Supabase access token for the authenticated session
 */
export async function registerBiometric(userId, userName = '', accessToken = '') {
  if (!isBiometricSupported()) {
    return { success: false, error: 'Biometric not supported on this device' };
  }
  if (!accessToken) {
    return {
      success: false,
      code: 'BIOMETRIC_SESSION_REQUIRED',
      error: BIOMETRIC_SESSION_REQUIRED_MESSAGE,
    };
  }

  try {
    const optionsRes = await fetchVerifyBiometric(accessToken, { action: 'get_registration_options' });
    if (!optionsRes.ok) {
      const err = await optionsRes.json().catch(() => ({}));
      const mapped = mapServerBiometricError(err?.error);
      return {
        success: false,
        error: mapped || safeWebAuthnError(err, 'Failed to start biometric enrollment'),
      };
    }

    const {
      challenge: challengeB64url,
      challenge_id: challengeId,
      rp_id: rpId,
      rp_name: rpName,
    } = await optionsRes.json();

    if (!challengeB64url || !challengeId || !rpId || !rpName) {
      return { success: false, error: 'Failed to start biometric enrollment' };
    }

    const challengeBytes = base64urlToUint8Array(challengeB64url);
    const userName_ = userName || userId || 'user@zuri.local';

    const registrationOptions = {
      challenge: challengeBytes,
      rp: {
        name: rpName,
        id:   rpId,
      },
      user: {
        id:          new TextEncoder().encode(userId),
        name:        userName_,
        displayName: userName_,
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification:        'required',
        residentKey:             'preferred',
      },
      timeout:     BIOMETRIC_ENROLL_TIMEOUT_MS,
      attestation: 'direct',
    };

    const credential = await withTimeout(
      navigator.credentials.create({ publicKey: registrationOptions }),
      'credentials_create',
      BIOMETRIC_ENROLL_TIMEOUT_MS
    );

    if (!credential) {
      return { success: false, error: BIOMETRIC_CANCELLED_MESSAGE };
    }

    const publicKeySpki = await extractPublicKeySpki(credential);
    if (!publicKeySpki) {
      return { success: false, error: BIOMETRIC_ENROLL_UNSUPPORTED_MESSAGE };
    }

    const credentialId = arrayBufferToBase64Url(credential.rawId);
    const algorithm = credential.response.getPublicKeyAlgorithm?.() ?? -7;

    // All binary WebAuthn fields are sent as base64url (URL-safe, no padding).
    // The verify-biometric Edge Function decoder accepts base64 OR base64url
    // for backward compatibility with any pre-existing stored credentials.
    const res = await fetchVerifyBiometric(accessToken, {
      action:             'register',
      credential_id:      credentialId,
      public_key_spki:    publicKeySpki,
      algorithm,
      challenge_id:       challengeId,
      client_data_json:   arrayBufferToBase64Url(credential.response.clientDataJSON),
      attestation_object: arrayBufferToBase64Url(credential.response.attestationObject),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const mapped = mapServerBiometricError(err?.error);
      return {
        success: false,
        error: mapped || safeWebAuthnError(err, 'Server credential store failed'),
      };
    }

    // Cache only the non-sensitive credential_id locally so isBiometricEnrolled() is fast.
    // We also record the enrollment timestamp so the UI can show a friendly date.
    // No PII or credential material is written — just an ISO-8601 timestamp.
    const enrolledAt = new Date().toISOString();
    try {
      localStorage.setItem(`biometric_cred_id_${userId}`, credentialId);
      localStorage.setItem(`biometric_enrolled_at_${userId}`, enrolledAt);
    } catch (e) {
      console.warn('[Biometric] localStorage write failed:', e);
    }

    return {
      success:      true,
      credentialId,
      enrolledAt,
      message:      'Biometric enrolled successfully',
    };
  } catch (error) {
    console.error('[Biometric] Registration failed:', sanitizeBiometricError(error));
    return { success: false, error: toSafeBiometricError(error, 'Biometric registration failed') };
  }
}

// ── Authentication ────────────────────────────────────────────────────────────

/**
 * Authenticate with biometrics.
 * Challenge is fetched from the server (single-use).
 * Assertion is verified fully server-side (signature, rpIdHash, signCount, etc.).
 *
 * @param {string} userId
 * @param {string} accessToken  — Supabase access token
 */
export async function authenticateBiometric(userId, accessToken = '') {
  if (!isBiometricSupported()) {
    return { success: false, error: 'Biometric not supported on this device' };
  }
  if (!accessToken) {
    return {
      success: false,
      code: 'BIOMETRIC_SESSION_REQUIRED',
      error: 'Please sign in again before using biometrics.',
    };
  }

  // Read the cached credential_id (non-sensitive).
  let credentialId;
  try {
    credentialId = localStorage.getItem(`biometric_cred_id_${userId}`);
  } catch (e) {
    console.warn('[Biometric] localStorage read error:', e);
  }
  if (!credentialId) {
    return { success: false, error: 'Biometric not enrolled on this device' };
  }

  try {
    // 1. Get a single-use server-side challenge.
    const challengeRes = await fetchVerifyBiometric(accessToken, { action: 'get_challenge' });
    if (!challengeRes.ok) {
      const err = await challengeRes.json().catch(() => ({}));
      const mapped = mapServerBiometricError(err?.error);
      return { success: false, error: mapped || 'Failed to get challenge from server' };
    }
    const { challenge: challengeB64url, challenge_id: challengeId } = await challengeRes.json();
    const challengeBytes = base64urlToUint8Array(challengeB64url);

    const authOptions = {
      challenge:         challengeBytes,
      timeout:           BIOMETRIC_RESTORE_TIMEOUT_MS,
      userVerification:  'required',
      allowCredentials:  [{
        type:       'public-key',
        id:         base64ToArrayBuffer(credentialId),
        transports: ['internal'],
      }],
    };

    // 2. Collect the assertion from the browser / platform authenticator.
    const assertion = await withTimeout(
      navigator.credentials.get({ publicKey: authOptions }),
      'credentials_get',
      BIOMETRIC_RESTORE_TIMEOUT_MS
    );

    if (!assertion) {
      return { success: false, error: 'Biometric authentication cancelled' };
    }

    // 3. Send assertion to the server for full cryptographic verification.
    const verifyRes = await fetchVerifyBiometric(accessToken, {
      action:             'verify',
      challenge_id:       challengeId,
      credential_id:      credentialId,
      client_data_json:   arrayBufferToBase64Url(assertion.response.clientDataJSON),
      authenticator_data: arrayBufferToBase64Url(assertion.response.authenticatorData),
      signature:          arrayBufferToBase64Url(assertion.response.signature),
    });

    if (!verifyRes.ok) {
      const err = await verifyRes.json().catch(() => ({}));
      return { success: false, error: err?.error ?? 'Server-side verification failed' };
    }

    const verifyData = await verifyRes.json();
    if (!verifyData?.verified) {
      return { success: false, error: 'Server reported verification failure' };
    }

    try {
      const trust = JSON.parse(sessionStorage.getItem('device_trust') || '{}');
      trust.lastBiometricAuth  = new Date().toISOString();
      trust.authSuccessCount   = (trust.authSuccessCount || 0) + 1;
      sessionStorage.setItem('device_trust', JSON.stringify(trust));
    } catch (e) {
      console.warn('[Biometric] Trust update error:', e);
    }

    return {
      success:       true,
      userId,
      authenticator: 'platform',
      timestamp:     new Date().toISOString(),
      message:       'Biometric authentication successful',
      proof: {
        challenge_id:       challengeId,
        credential_id:      credentialId,
        client_data_json:   arrayBufferToBase64Url(assertion.response.clientDataJSON),
        authenticator_data: arrayBufferToBase64Url(assertion.response.authenticatorData),
        signature:          arrayBufferToBase64Url(assertion.response.signature),
      },
    };
  } catch (error) {
    console.error('[Biometric] Authentication failed:', sanitizeBiometricError(error));
    return { success: false, error: sanitizeBiometricError(error) || 'Biometric authentication failed' };
  }
}

// ── Enrollment queries ────────────────────────────────────────────────────────

export function isBiometricEnrolled(userId) {
  try {
    return !!localStorage.getItem(`biometric_cred_id_${userId}`);
  } catch (e) {
    return false;
  }
}

export async function clearBiometricEnrollment(userId) {
  try {
    localStorage.removeItem(`biometric_cred_id_${userId}`);
    localStorage.removeItem(`biometric_enrolled_at_${userId}`);
    return { success: true, message: 'Biometric enrollment cleared' };
  } catch (e) {
    console.error('[Biometric] Clear enrollment failed:', e);
    return { success: false, error: e?.message || 'Failed to clear enrollment' };
  }
}

export async function getBiometricEnrollmentInfo(userId) {
  const credentialId = (() => {
    try { return localStorage.getItem(`biometric_cred_id_${userId}`); }
    catch { return null; }
  })();
  if (!credentialId) return null;
  const enrolledAt = (() => {
    try { return localStorage.getItem(`biometric_enrolled_at_${userId}`) || null; }
    catch { return null; }
  })();
  return {
    enrolled:     true,
    credentialId,
    enrolledAt,
  };
}
