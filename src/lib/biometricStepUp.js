/**
 * biometricStepUp — high-level frontend helper for action-bound WebAuthn
 * step-up authorization.
 *
 * Security model (verified by `verify-biometric` + `complete-step-up`):
 *  - Challenges are minted server-side, action-bound, single-use, short-TTL.
 *  - Each challenge is tied to a specific step_up_challenge id (and pending
 *    payment when applicable), action_type, amount, recipient via a server-
 *    computed binding_hash.
 *  - The frontend NEVER claims verification success — that flag is set only
 *    after the server returns `ok: true` from complete-step-up / set-pin /
 *    verify-biometric.
 *  - We never write the challenge, assertion, or credential ID to localStorage
 *    as proof. localStorage is used only to look up the enrolled credential id
 *    (which the server already knows about via webauthn_credentials).
 *
 * IMPORTANT: this module does NOT call verify-biometric.verify itself. The
 * assertion goes straight to complete-step-up so the server-side binding check
 * is the single source of truth. Calling verify-biometric.verify would consume
 * the challenge before complete-step-up could check the binding.
 */

import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

const FUNCTIONS_BASE = `${import.meta.env.VITE_SUPABASE_URL ?? ''}/functions/v1`;
const STEP_UP_ASSERTION_TIMEOUT_MS = 60_000;

export const BIOMETRIC_UNSUPPORTED_MESSAGE = 'This device does not support biometric authorization.';
export const BIOMETRIC_NO_CREDENTIAL_MESSAGE = 'No biometric is set up for this account. Use your PIN.';
export const BIOMETRIC_CANCELLED_MESSAGE = 'Authorization cancelled. No payment was sent.';
export const BIOMETRIC_VERIFICATION_FAILED_MESSAGE = 'Verification failed. Try again or use PIN.';
export const BIOMETRIC_SESSION_REQUIRED_MESSAGE = 'Please sign in again to authorize.';

const TRANSIENT_LOG_KEY = '[BiometricStepUp]';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeForLog(error) {
  const raw = String(error?.message || error?.error || error || 'unknown');
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/access_token["']?\s*[:=]\s*["']?[^"',\s}]+/gi, 'access_token=[redacted]')
    .replace(/challenge["']?\s*[:=]\s*["']?[A-Za-z0-9_-]+/gi, 'challenge=[redacted]')
    .replace(/authenticator_data["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]+/gi, 'authenticator_data=[redacted]')
    .replace(/client_data_json["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]+/gi, 'client_data_json=[redacted]')
    .replace(/signature["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]+/gi, 'signature=[redacted]')
    .replace(/credential_id["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]+/gi, 'credential_id=[redacted]');
}

export function isWebAuthnSupported() {
  try {
    return (
      typeof window !== 'undefined' &&
      window.PublicKeyCredential !== undefined &&
      navigator?.credentials?.get !== undefined
    );
  } catch {
    return false;
  }
}

function arrayBufferToBase64Url(buffer) {
  if (!buffer) return '';
  const bytes = buffer instanceof ArrayBuffer
    ? new Uint8Array(buffer)
    : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

function withTimeout(promise, label, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}_timeout`)), ms)),
  ]);
}

async function fetchVerifyBiometric(accessToken, payload) {
  return fetch(`${FUNCTIONS_BASE}/verify-biometric`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
}

async function loadAccessToken() {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) {
    const e = new Error(BIOMETRIC_SESSION_REQUIRED_MESSAGE);
    e.code = 'BIOMETRIC_SESSION_REQUIRED';
    throw e;
  }
  return data.session.access_token;
}

/**
 * Mint a fresh, action-bound WebAuthn assertion challenge from the server.
 *
 * @param {object} params
 * @param {string} params.stepUpChallengeId   server-issued step_up_challenge id
 * @param {string} params.actionType           one of WebAuthnActionType
 * @param {object} [params.binding]            optional non-payment binding inputs
 * @param {string} [params.accessToken]        Supabase access token (auto-fetched if absent)
 */
export async function requestStepUpAssertionOptions({
  stepUpChallengeId,
  actionType,
  binding = {},
  accessToken,
}) {
  if (!stepUpChallengeId) throw new Error('step_up_challenge_id_required');
  if (!actionType) throw new Error('action_type_required');

  const token = accessToken || await loadAccessToken();
  const res = await fetchVerifyBiometric(token, {
    action: 'get_step_up_assertion_options',
    step_up_challenge_id: stepUpChallengeId,
    action_type: actionType,
    binding,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const e = new Error(errBody?.error || 'assertion_options_failed');
    e.code = errBody?.error || 'assertion_options_failed';
    e.status = res.status;
    throw e;
  }

  const json = await res.json();
  if (!json?.challenge || !json?.challenge_id || !Array.isArray(json.allow_credentials)) {
    throw new Error('assertion_options_invalid_response');
  }
  return json;
}

/**
 * Run navigator.credentials.get with the server-issued challenge. Returns the
 * serialized assertion fields (NOT yet verified — that happens server-side).
 */
export async function signStepUpAssertion(options) {
  if (!isWebAuthnSupported()) {
    const e = new Error(BIOMETRIC_UNSUPPORTED_MESSAGE);
    e.code = 'biometric_unsupported';
    throw e;
  }
  if (!options?.challenge || !Array.isArray(options.allow_credentials) || options.allow_credentials.length === 0) {
    const e = new Error('assertion_options_invalid');
    e.code = 'assertion_options_invalid';
    throw e;
  }

  const publicKey = {
    challenge: base64AnyToUint8Array(options.challenge),
    timeout: STEP_UP_ASSERTION_TIMEOUT_MS,
    userVerification: 'required',
    rpId: options.rp_id || undefined,
    allowCredentials: options.allow_credentials.map((cred) => ({
      id: base64AnyToUint8Array(cred.id).buffer,
      type: 'public-key',
      transports: Array.isArray(cred.transports) && cred.transports.length ? cred.transports : ['internal'],
    })),
  };

  let assertion;
  try {
    assertion = await withTimeout(
      navigator.credentials.get({ publicKey }),
      'credentials_get',
      STEP_UP_ASSERTION_TIMEOUT_MS,
    );
  } catch (err) {
    // Browsers surface user cancellation as NotAllowedError. Map to a polished
    // user-facing message instead of leaking raw DOMException details.
    const message = String(err?.name || err?.message || 'unknown');
    if (/NotAllowedError|AbortError|cancel/i.test(message)) {
      const e = new Error(BIOMETRIC_CANCELLED_MESSAGE);
      e.code = 'biometric_cancelled';
      throw e;
    }
    const e = new Error(BIOMETRIC_VERIFICATION_FAILED_MESSAGE);
    e.code = 'biometric_failed';
    throw e;
  }
  if (!assertion) {
    const e = new Error(BIOMETRIC_CANCELLED_MESSAGE);
    e.code = 'biometric_cancelled';
    throw e;
  }

  return {
    challenge_id: options.challenge_id,
    credential_id: arrayBufferToBase64Url(assertion.rawId),
    client_data_json: arrayBufferToBase64Url(assertion.response.clientDataJSON),
    authenticator_data: arrayBufferToBase64Url(assertion.response.authenticatorData),
    signature: arrayBufferToBase64Url(assertion.response.signature),
  };
}

/**
 * One-shot helper: mint a server challenge, run the WebAuthn ceremony, return
 * the proof object that can be passed straight to completeServerStepUp /
 * set-pin. The caller MUST send this proof to the server — frontend success
 * is meaningless until the server returns ok.
 */
export async function performBiometricStepUp({
  stepUpChallengeId,
  actionType,
  binding = {},
  accessToken,
}) {
  try {
    const token = accessToken || await loadAccessToken();
    const options = await requestStepUpAssertionOptions({
      stepUpChallengeId,
      actionType,
      binding,
      accessToken: token,
    });
    const proof = await signStepUpAssertion(options);
    return { ok: true, proof };
  } catch (err) {
    try {
      // Sanitize before logging — no raw assertion, no challenge, no token.
      console.warn(`${TRANSIENT_LOG_KEY} step_up_failed`, sanitizeForLog(err));
    } catch { /* logger may not exist in test env */ }
    return {
      ok: false,
      code: err?.code || 'biometric_failed',
      message: err?.code === 'BIOMETRIC_SESSION_REQUIRED'
        ? BIOMETRIC_SESSION_REQUIRED_MESSAGE
        : err?.code === 'biometric_unsupported'
          ? BIOMETRIC_UNSUPPORTED_MESSAGE
          : err?.code === 'no_credentials_enrolled'
            ? BIOMETRIC_NO_CREDENTIAL_MESSAGE
            : err?.code === 'biometric_cancelled'
              ? BIOMETRIC_CANCELLED_MESSAGE
              : BIOMETRIC_VERIFICATION_FAILED_MESSAGE,
    };
  }
}

export { isPlainObject as _isPlainObjectForTest, sanitizeForLog as _sanitizeForLogForTest };
