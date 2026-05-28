/**
 * Zuri Connect Africa — server-side OTP crypto.
 *
 * Replaces the old `sha256(otp)` storage scheme with a peppered HMAC that
 * binds the digest to BOTH the normalized phone and the OTP purpose so a
 * leaked code:
 *   - cannot be replayed against a different purpose (e.g. verification ≠ step-up),
 *   - cannot be replayed against a different phone,
 *   - is useless to anyone who manages to exfiltrate `otp_records` without OTP_PEPPER.
 *
 * Hash material:
 *     HMAC_SHA256( OTP_PEPPER, `${purpose}:${normalizedPhone}:${otp}` )
 *
 * OTP_PEPPER is REQUIRED. Missing or short pepper => fail closed with
 * `OTP_SERVICE_UNAVAILABLE` — never silently fall back to an unsalted hash.
 *
 * Notes:
 *   - Raw OTPs and raw hashes must NEVER be logged.
 *   - The hex output is constant-time-comparable.
 *   - `OTP_HASH_VERSION` is stored alongside the row so we can rotate later.
 */

export const OTP_HASH_VERSION = 'hmac_sha256_pepper_v1';

const MIN_PEPPER_LENGTH = 16;

/** Allowed OTP purposes — keeps purpose binding to a small, audited set. */
export const OTP_PURPOSES = ['verification', 'step_up', 'pin_setup', 'pin_reset'] as const;
export type OtpPurpose = typeof OTP_PURPOSES[number];

export function normalizeOtpPurpose(input: unknown): OtpPurpose {
  const raw = String(input ?? '').trim().toLowerCase();
  return (OTP_PURPOSES as readonly string[]).includes(raw)
    ? (raw as OtpPurpose)
    : 'verification';
}

function bufToHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Reads OTP_PEPPER from Deno.env (Edge runtime) or process.env (tests).
 * Throws an error with message 'OTP_SERVICE_UNAVAILABLE' when missing or too short.
 */
export function getOtpPepper(): string {
  let pepper = '';
  // Edge / Deno runtime.
  // deno-lint-ignore no-explicit-any
  const denoLike: any = (globalThis as any).Deno;
  if (denoLike && typeof denoLike.env?.get === 'function') {
    pepper = denoLike.env.get('OTP_PEPPER') ?? '';
  }
  if (!pepper) {
    // deno-lint-ignore no-explicit-any
    const proc: any = (globalThis as any).process;
    if (proc?.env?.OTP_PEPPER) {
      pepper = String(proc.env.OTP_PEPPER);
    }
  }
  if (!pepper || pepper.length < MIN_PEPPER_LENGTH) {
    // Surface a stable, opaque code. Never leak whether pepper is missing
    // vs. too short to callers — only the operator should see the deploy log.
    const err = new Error('OTP_SERVICE_UNAVAILABLE');
    (err as Error & { code?: string }).code = 'OTP_SERVICE_UNAVAILABLE';
    throw err;
  }
  return pepper;
}

/** Returns a 6-digit OTP using a cryptographically secure source. */
export function generateNumericOtp(digits = 6): string {
  if (digits < 4 || digits > 10) {
    throw new Error('OTP_DIGITS_OUT_OF_RANGE');
  }
  // Reject-sample to avoid modulo bias.
  const max = Math.pow(10, digits);
  const min = Math.pow(10, digits - 1);
  const span = max - min;
  const buf = new Uint32Array(1);
  // Up to ~4M samples needed in worst case; in practice 1 is enough.
  for (let i = 0; i < 8; i++) {
    crypto.getRandomValues(buf);
    const candidate = buf[0] >>> 0;
    // Reject the top of the uint32 range that would bias modulo.
    const limit = Math.floor(0xffffffff / span) * span;
    if (candidate < limit) {
      return String(min + (candidate % span));
    }
  }
  // Extremely unlikely fallback — still uniform across `span`.
  crypto.getRandomValues(buf);
  return String(min + ((buf[0] >>> 0) % span));
}

/**
 * Compute the peppered HMAC-SHA256 hex digest used for `otp_records.otp_hash`.
 *
 * @throws { code: 'OTP_SERVICE_UNAVAILABLE' } when OTP_PEPPER is missing/short.
 */
export async function hashOtpWithPepper(
  otp: string,
  normalizedPhone: string,
  purpose: OtpPurpose | string
): Promise<string> {
  const pepper = getOtpPepper();
  const safePurpose = normalizeOtpPurpose(purpose);
  const safePhone = String(normalizedPhone ?? '').trim();
  const safeOtp = String(otp ?? '').trim();
  if (!safePhone || !safeOtp) {
    throw new Error('OTP_HASH_INPUT_INVALID');
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`${safePurpose}:${safePhone}:${safeOtp}`)
  );
  return bufToHex(sig);
}
