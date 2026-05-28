import { env } from '@/config/env.js';

const PHONE_AUTH_KEYS = {
  verified: 'zuri_phone_verified',
  phone: 'zuri_verified_phone',
  ts: 'zuri_session_ts',
};

const LOCAL_DEMO_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export const KENYAN_PHONE_ERROR =
  'Enter a valid Kenyan mobile number, e.g. 0712 345 678 or 0143 305 099.';

/**
 * Polished, user-safe copy for the stable OTP send error codes the server
 * returns. We never echo provider details (AT response bodies, OTPs, API keys)
 * to the user; only one of these stable codes makes it to the browser.
 */
export const OTP_SEND_ERROR_COPY = Object.freeze({
  SMS_SEND_FAILED:           'We could not send the code right now. Please try again.',
  SMS_PROVIDER_REJECTED:     'We could not send the code right now. Please try again.',
  SMS_PROVIDER_RATE_LIMITED: 'We could not send the code right now. Please try again.',
  OTP_SERVICE_UNAVAILABLE:   'OTP service is not ready. Please try again shortly.',
  SMS_PROVIDER_MISCONFIGURED:'OTP service is not ready. Please try again shortly.',
});

/**
 * The server returns `{ error: 'rate_limited', retryAfterSeconds, blocked }`
 * with HTTP 429 when a phone or IP exceeds its OTP-send window. We format the
 * retry window in whole minutes (rounded up) without exposing the underlying
 * rate-limit policy.
 */
export function formatRateLimitedRetryMessage(retryAfterSeconds) {
  const secondsRaw = Number(retryAfterSeconds);
  if (!Number.isFinite(secondsRaw) || secondsRaw <= 0) {
    return 'Too many attempts. Please try again in a few minutes.';
  }
  const minutes = Math.max(1, Math.ceil(secondsRaw / 60));
  const noun = minutes === 1 ? 'minute' : 'minutes';
  return `Too many attempts. Please try again in about ${minutes} ${noun}.`;
}

/**
 * Map an OTP-send error (an ApiError instance from invokeEdgeFunction, a raw
 * server response body, or a bare error code string) to polished user copy.
 *
 *   * `rate_limited` (HTTP 429) is rendered with the server-supplied
 *     `retryAfterSeconds` in whole minutes.
 *   * Stable provider codes use the frozen `OTP_SEND_ERROR_COPY` map.
 *   * Everything else returns `null` so the caller can pick a generic fallback
 *     (or log it, in non-prod).
 *
 * This function never inspects raw provider payloads and never returns
 * server-supplied free-form strings.
 */
export function mapOtpSendErrorToCopy(errOrCode) {
  if (errOrCode == null) return null;

  if (typeof errOrCode === 'string') {
    return OTP_SEND_ERROR_COPY[errOrCode] || null;
  }

  const body = errOrCode?.body && typeof errOrCode.body === 'object' ? errOrCode.body : null;
  const status = Number(errOrCode?.status);
  // `errOrCode.error` covers the in-band case where the caller passed the
  // server response body directly (200 with `success:false`); `body.error`
  // covers the ApiError shape from invokeEdgeFunction; `code`/`message` cover
  // bare Error-like inputs.
  const code = String(
    body?.error ?? errOrCode?.error ?? errOrCode?.code ?? errOrCode?.message ?? '',
  );

  if (code === 'rate_limited' || (Number.isFinite(status) && status === 429)) {
    const seconds =
      body?.retryAfterSeconds ?? errOrCode?.retryAfterSeconds ?? null;
    return formatRateLimitedRetryMessage(seconds);
  }

  return OTP_SEND_ERROR_COPY[code] || null;
}

export class PhoneOtpSessionRequiredError extends Error {
  constructor(message = 'PHONE_OTP_SESSION_REQUIRED') {
    super(message);
    this.name = 'PhoneOtpSessionRequiredError';
    this.code = 'PHONE_OTP_SESSION_REQUIRED';
  }
}

export class KenyanPhoneFormatError extends Error {
  constructor(message = KENYAN_PHONE_ERROR) {
    super(message);
    this.name = 'KenyanPhoneFormatError';
    this.code = 'INVALID_KENYAN_PHONE';
  }
}

export function normalizePhoneForSupabase(phone) {
  const cleaned = String(phone || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[^\d+]/g, '');
  const digits = cleaned.replace(/^\+/, '');
  let nationalNumber = null;

  if (/^254[71]\d{8}$/.test(digits)) {
    nationalNumber = digits.slice(3);
  } else if (/^2540[71]\d{8}$/.test(digits)) {
    nationalNumber = digits.slice(4);
  } else if (/^0[71]\d{8}$/.test(digits)) {
    nationalNumber = digits.slice(1);
  } else if (/^[71]\d{8}$/.test(digits)) {
    nationalNumber = digits;
  }

  if (nationalNumber && /^[71]\d{8}$/.test(nationalNumber)) {
    return `+254${nationalNumber}`;
  }

  throw new KenyanPhoneFormatError();
}

export function computePhoneOtpDemoAllowed({ appEnv, strictEnv, allowClientDemoControlsFlag }) {
  return appEnv === 'local' && strictEnv !== true && allowClientDemoControlsFlag === true;
}

export function isLocalDemoPhoneOtpAllowed() {
  return computePhoneOtpDemoAllowed({
    appEnv: env.appEnv,
    strictEnv: env.strictEnv,
    allowClientDemoControlsFlag: import.meta.env.VITE_ALLOW_CLIENT_DEMO_CONTROLS === 'true',
  });
}

export function clearLocalDemoPhoneSession() {
  try {
    localStorage.removeItem(PHONE_AUTH_KEYS.verified);
    localStorage.removeItem(PHONE_AUTH_KEYS.phone);
    localStorage.removeItem(PHONE_AUTH_KEYS.ts);
  } catch {
    /* ignore */
  }
}

export function setLocalDemoPhoneSession(phone) {
  if (!isLocalDemoPhoneOtpAllowed()) {
    throw new PhoneOtpSessionRequiredError();
  }
  const normalizedPhone = normalizePhoneForSupabase(phone);
  localStorage.setItem(PHONE_AUTH_KEYS.verified, '1');
  localStorage.setItem(PHONE_AUTH_KEYS.phone, normalizedPhone);
  localStorage.setItem(PHONE_AUTH_KEYS.ts, Date.now().toString());
  window.dispatchEvent(new CustomEvent('zuri:local-demo-phone-auth'));
  return normalizedPhone;
}

export function getLocalDemoPhoneUser() {
  if (!isLocalDemoPhoneOtpAllowed()) return null;
  try {
    if (localStorage.getItem(PHONE_AUTH_KEYS.verified) !== '1') return null;
    const phone = localStorage.getItem(PHONE_AUTH_KEYS.phone);
    const ts = Number(localStorage.getItem(PHONE_AUTH_KEYS.ts) || 0);
    if (!phone || !ts || Date.now() - ts > LOCAL_DEMO_SESSION_MAX_AGE_MS) {
      clearLocalDemoPhoneSession();
      return null;
    }
    const normalizedPhone = normalizePhoneForSupabase(phone);
    return {
      id: `local-phone-demo:${normalizedPhone}`,
      email: `${normalizedPhone.replace(/\D/g, '')}@phone.local`,
      phone: normalizedPhone,
      aud: 'authenticated',
      role: 'customer',
      full_name: 'Local Phone Demo',
      created_at: new Date(ts).toISOString(),
      localDemo: true,
    };
  } catch {
    clearLocalDemoPhoneSession();
    return null;
  }
}

export async function requireSupabaseSession(supabase) {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!session?.user) throw new PhoneOtpSessionRequiredError();
  return session;
}

export async function requestSupabasePhoneOtp(supabase, phone) {
  const normalizedPhone = normalizePhoneForSupabase(phone);
  const { error } = await supabase.auth.signInWithOtp({ phone: normalizedPhone });
  if (error) throw error;
  return { phone: normalizedPhone };
}

export async function verifySupabasePhoneOtp(supabase, phone, otp) {
  const normalizedPhone = normalizePhoneForSupabase(phone);
  const { data, error } = await supabase.auth.verifyOtp({
    phone: normalizedPhone,
    token: otp,
    type: 'sms',
  });
  if (error) throw error;
  return data?.session?.user ? data.session : requireSupabaseSession(supabase);
}

export async function completeCustomPhoneOtpVerification(supabase, phone) {
  try {
    return await requireSupabaseSession(supabase);
  } catch (sessionError) {
    if (isLocalDemoPhoneOtpAllowed()) {
      setLocalDemoPhoneSession(phone);
      return { user: getLocalDemoPhoneUser(), localDemo: true };
    }
    throw sessionError instanceof PhoneOtpSessionRequiredError
      ? sessionError
      : new PhoneOtpSessionRequiredError();
  }
}
