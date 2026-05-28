// Web Crypto API-based PIN security utilities — Zuri Connect Africa

import { getClientDemoPolicy } from '@/config/clientSecurityPolicy.js';

const STORAGE_KEY  = 'zuri_pin_hash';
const ENROLLED_KEY = 'zuri_pin_enrolled';
const ATTEMPTS_KEY = 'zuri_pin_attempts';
const LOCKOUT_KEY  = 'zuri_pin_lockout';

const MAX_ATTEMPTS       = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

// ── Local UX hashing (never written to pin_hash_metadata) ─────────────────────
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES        = 32;

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes.buffer;
}

async function derivePbkdf2Hash(pin, saltBuf) {
  const enc    = new TextEncoder();
  const keyMat = await crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name:       'PBKDF2',
      salt:       saltBuf,
      iterations: PBKDF2_ITERATIONS,
      hash:       'SHA-256',
    },
    keyMat,
    256
  );
  return bits;
}

export async function hashPin(pin) {
  const saltBuf = crypto.getRandomValues(new Uint8Array(SALT_BYTES)).buffer;
  const hashBuf = await derivePbkdf2Hash(pin, saltBuf);
  return `${bufToHex(saltBuf)}:${bufToHex(hashBuf)}`;
}

export async function verifyPin(pin, storedValue) {
  if (!storedValue) return false;

  if (!storedValue.includes(':')) {
    const enc  = new TextEncoder();
    const data = enc.encode(pin + 'zuri_salt_v1');
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return bufToHex(buf) === storedValue;
  }

  const colonIdx = storedValue.indexOf(':');
  const saltHex  = storedValue.slice(0, colonIdx);
  const hashHex  = storedValue.slice(colonIdx + 1);
  const saltBuf  = hexToBuf(saltHex);
  const hashBuf  = await derivePbkdf2Hash(pin, saltBuf);
  return bufToHex(hashBuf) === hashHex;
}

async function getAccessToken() {
  const { getSupabaseBrowserClient } = await import('@/lib/supabase/client.js');
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.getSession();
  if (error || !data?.session?.access_token) {
    throw new Error('AUTH_REQUIRED: Sign in before managing your PIN.');
  }
  return data.session.access_token;
}

/**
 * Server-authoritative PIN enrollment/change via set-pin Edge Function.
 * Raw PIN is sent over TLS once and hashed server-side with PIN_PEPPER.
 */
export async function enrollPinOnServer(pin, {
  action = 'setup',
  otp,
  current_pin,
  step_up_challenge_id,
  biometricProof = {},
} = {}) {
  const normalized = String(pin || '').trim();
  if (!/^\d{6}$/.test(normalized)) {
    throw new Error('PIN must be exactly 6 digits.');
  }

  const { invokeEdgeFunction } = await import('@/api/client.js');
  const accessToken = await getAccessToken();
  const payload = {
    action,
    pin: normalized,
    ...(otp ? { otp } : {}),
    ...(current_pin ? { current_pin } : {}),
    ...(step_up_challenge_id ? { step_up_challenge_id } : {}),
    ...biometricProof,
  };

  const result = await invokeEdgeFunction('setPin', payload, accessToken);
  if (!result?.ok) {
    throw new Error(result?.message || result?.error || 'Could not save PIN on server.');
  }
  return result;
}

/**
 * @deprecated Use enrollPinOnServer. Never writes pin_hash from the browser.
 */
export async function syncPinHashToServer(_pinOrHash = null, proof = {}) {
  if (getClientDemoPolicy().hardenedSurface) {
    console.warn('[security] syncPinHashToServer is disabled in hardened environments. Use enrollPinOnServer with OTP/biometric proof.');
    return { ok: false, skipped: true };
  }
  if (typeof _pinOrHash === 'string' && /^\d{6}$/.test(_pinOrHash)) {
    return enrollPinOnServer(_pinOrHash, { action: 'setup', ...proof });
  }
  return { ok: false, skipped: true };
}

export async function storePinHash(pin, proof = {}) {
  const policy = getClientDemoPolicy();

  if (policy.hardenedSurface) {
    const hasProof = Boolean(
      proof?.otp
      || proof?.step_up_challenge_id
      || proof?.challenge_id
      || proof?.credential_id
    );
    if (!hasProof) {
      throw new Error('Verify with OTP or biometric before creating your PIN.');
    }
    await enrollPinOnServer(pin, {
      action: 'setup',
      otp: proof.otp,
      step_up_challenge_id: proof.step_up_challenge_id,
      biometricProof: proof.biometricProof || proof,
    });
  } else if (proof?.otp || proof?.challenge_id) {
    try {
      await enrollPinOnServer(pin, {
        action: 'setup',
        otp: proof.otp,
        biometricProof: proof.biometricProof || proof,
      });
    } catch {
      /* demo fallback */
    }
  }

  const hash = await hashPin(pin);
  sessionStorage.setItem(STORAGE_KEY, hash);
  sessionStorage.setItem(ENROLLED_KEY, '1');
}

export function getStoredPinHash() {
  return sessionStorage.getItem(STORAGE_KEY) || null;
}

export function hasPinSet() {
  return Boolean(sessionStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(ENROLLED_KEY));
}

export const isPinSet = hasPinSet;

export function getFailedAttempts() {
  return parseInt(sessionStorage.getItem(ATTEMPTS_KEY) || '0', 10);
}

export function recordFailedAttempt() {
  const attempts = getFailedAttempts() + 1;
  sessionStorage.setItem(ATTEMPTS_KEY, String(attempts));

  if (attempts >= MAX_ATTEMPTS) {
    const lockoutUntil = Date.now() + LOCKOUT_DURATION_MS;
    sessionStorage.setItem(LOCKOUT_KEY, String(lockoutUntil));
    return { attempts, locked: true, lockoutUntil };
  }

  return { attempts, locked: false, lockoutUntil: null };
}

export function clearFailedAttempts() {
  sessionStorage.removeItem(ATTEMPTS_KEY);
  sessionStorage.removeItem(LOCKOUT_KEY);
}

export function getLockoutRemaining() {
  const lockoutUntil = parseInt(sessionStorage.getItem(LOCKOUT_KEY) || '0', 10);
  const remaining    = lockoutUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function getRemainingLockout() {
  const remainingMs      = getLockoutRemaining();
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return { locked: remainingMs > 0, remainingSeconds };
}

export function isLockedOut() {
  return getLockoutRemaining() > 0;
}
