import { afterEach, describe, expect, it, vi } from 'vitest';

async function importPhoneOtpSession(env = {}) {
  vi.resetModules();
  vi.stubEnv('VITE_SUPABASE_URL', env.VITE_SUPABASE_URL || 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', env.VITE_SUPABASE_ANON_KEY || 'a'.repeat(32));
  vi.stubEnv('VITE_APP_ENV', env.VITE_APP_ENV || 'production');
  vi.stubEnv('VITE_STRICT_ENV', env.VITE_STRICT_ENV || 'false');
  vi.stubEnv('VITE_ALLOW_CLIENT_DEMO_CONTROLS', env.VITE_ALLOW_CLIENT_DEMO_CONTROLS || 'false');
  return import('@/lib/auth/phoneOtpSession.js');
}

describe('phone OTP session strategy', () => {
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('normalizes common Kenyan local and international phone formats to E.164', async () => {
    const { normalizePhoneForSupabase } = await importPhoneOtpSession();

    expect(normalizePhoneForSupabase('0712345678')).toBe('+254712345678');
    expect(normalizePhoneForSupabase('0110123456')).toBe('+254110123456');
    expect(normalizePhoneForSupabase('0143305099')).toBe('+254143305099');
    expect(normalizePhoneForSupabase('712345678')).toBe('+254712345678');
    expect(normalizePhoneForSupabase('110123456')).toBe('+254110123456');
    expect(normalizePhoneForSupabase('143305099')).toBe('+254143305099');
    expect(normalizePhoneForSupabase('+254712345678')).toBe('+254712345678');
    expect(normalizePhoneForSupabase('+254110123456')).toBe('+254110123456');
    expect(normalizePhoneForSupabase('+254143305099')).toBe('+254143305099');
    expect(normalizePhoneForSupabase('254712345678')).toBe('+254712345678');
    expect(normalizePhoneForSupabase('254110123456')).toBe('+254110123456');
    expect(normalizePhoneForSupabase('254143305099')).toBe('+254143305099');
  });

  it('safely handles malformed +2540 Kenyan mobile input without sending +2540', async () => {
    const { normalizePhoneForSupabase } = await importPhoneOtpSession();

    expect(normalizePhoneForSupabase('+2540712345678')).toBe('+254712345678');
    expect(normalizePhoneForSupabase('+2540110123456')).toBe('+254110123456');
    expect(normalizePhoneForSupabase('+2540143305099')).toBe('+254143305099');
  });

  it('rejects invalid Kenyan phone shapes with polished user-facing copy', async () => {
    const { KENYAN_PHONE_ERROR, normalizePhoneForSupabase } = await importPhoneOtpSession();

    expect(() => normalizePhoneForSupabase('014330509')).toThrow(KENYAN_PHONE_ERROR);
    expect(() => normalizePhoneForSupabase('07123456')).toThrow(KENYAN_PHONE_ERROR);
    expect(() => normalizePhoneForSupabase('07123456789')).toThrow(KENYAN_PHONE_ERROR);
    expect(() => normalizePhoneForSupabase('+25407123456789')).toThrow(KENYAN_PHONE_ERROR);
    expect(() => normalizePhoneForSupabase('+255712345678')).toThrow(KENYAN_PHONE_ERROR);
    expect(() => normalizePhoneForSupabase('0201234567')).toThrow(KENYAN_PHONE_ERROR);
  });

  it('successful Supabase phone verify returns an authenticated session', async () => {
    const { verifySupabasePhoneOtp } = await importPhoneOtpSession();
    const session = { access_token: 'jwt', user: { id: 'phone-user', phone: '+254712345678' } };
    const supabase = {
      auth: {
        verifyOtp: vi.fn().mockResolvedValue({ data: { session }, error: null }),
        getSession: vi.fn(),
      },
    };

    const result = await verifySupabasePhoneOtp(supabase, '0712345678', '123456');

    expect(result).toBe(session);
    expect(supabase.auth.verifyOtp).toHaveBeenCalledWith({
      phone: '+254712345678',
      token: '123456',
      type: 'sms',
    });
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });

  it('custom OTP success without Supabase session does not unlock production app', async () => {
    const { completeCustomPhoneOtpVerification } = await importPhoneOtpSession({
      VITE_APP_ENV: 'production',
      VITE_ALLOW_CLIENT_DEMO_CONTROLS: 'true',
    });
    const supabase = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      },
    };

    await expect(completeCustomPhoneOtpVerification(supabase, '+254712345678'))
      .rejects.toMatchObject({ code: 'PHONE_OTP_SESSION_REQUIRED' });
    expect(localStorage.getItem('zuri_phone_verified')).toBeNull();
  });

  it('local demo phone OTP can enter only with explicit local demo flags', async () => {
    const { completeCustomPhoneOtpVerification, getLocalDemoPhoneUser } = await importPhoneOtpSession({
      VITE_APP_ENV: 'local',
      VITE_ALLOW_CLIENT_DEMO_CONTROLS: 'true',
      VITE_STRICT_ENV: 'false',
    });
    const supabase = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      },
    };

    const result = await completeCustomPhoneOtpVerification(supabase, '0712345678');

    expect(result.localDemo).toBe(true);
    expect(localStorage.getItem('zuri_phone_verified')).toBe('1');
    expect(getLocalDemoPhoneUser()).toMatchObject({
      phone: '+254712345678',
      role: 'customer',
      localDemo: true,
    });
  });

  it('production and staging cannot use localStorage phone_verified to bypass auth', async () => {
    localStorage.setItem('zuri_phone_verified', '1');
    localStorage.setItem('zuri_verified_phone', '+254712345678');
    localStorage.setItem('zuri_session_ts', Date.now().toString());

    const production = await importPhoneOtpSession({
      VITE_APP_ENV: 'production',
      VITE_ALLOW_CLIENT_DEMO_CONTROLS: 'true',
    });
    expect(production.getLocalDemoPhoneUser()).toBeNull();

    const staging = await importPhoneOtpSession({
      VITE_APP_ENV: 'staging',
      VITE_ALLOW_CLIENT_DEMO_CONTROLS: 'true',
    });
    expect(staging.getLocalDemoPhoneUser()).toBeNull();
  });

  it('maps send-otp rate_limited responses to a clear retry window in minutes', async () => {
    const { mapOtpSendErrorToCopy, formatRateLimitedRetryMessage } = await importPhoneOtpSession();

    // The exact payload the server returns today:
    //   429 + { ok:false, error:'rate_limited', retryAfterSeconds:1320, blocked:true }
    expect(mapOtpSendErrorToCopy({
      status: 429,
      body: { ok: false, error: 'rate_limited', retryAfterSeconds: 1320, blocked: true },
    })).toBe('Too many attempts. Please try again in about 22 minutes.');

    // Short windows round up to at least 1 minute (never "in about 0 minutes").
    expect(mapOtpSendErrorToCopy({
      status: 429,
      body: { error: 'rate_limited', retryAfterSeconds: 45 },
    })).toBe('Too many attempts. Please try again in about 1 minute.');

    // 1320s -> 22 minutes; 1380s -> 23 minutes (round-up boundary).
    expect(formatRateLimitedRetryMessage(1320)).toBe(
      'Too many attempts. Please try again in about 22 minutes.',
    );
    expect(formatRateLimitedRetryMessage(1380)).toBe(
      'Too many attempts. Please try again in about 23 minutes.',
    );
    expect(formatRateLimitedRetryMessage(60)).toBe(
      'Too many attempts. Please try again in about 1 minute.',
    );
  });

  it('falls back gracefully when retryAfterSeconds is missing, zero, or non-numeric', async () => {
    const { mapOtpSendErrorToCopy, formatRateLimitedRetryMessage } = await importPhoneOtpSession();
    const fallback = 'Too many attempts. Please try again in a few minutes.';

    expect(formatRateLimitedRetryMessage(undefined)).toBe(fallback);
    expect(formatRateLimitedRetryMessage(null)).toBe(fallback);
    expect(formatRateLimitedRetryMessage(0)).toBe(fallback);
    expect(formatRateLimitedRetryMessage(-1)).toBe(fallback);
    expect(formatRateLimitedRetryMessage('not a number')).toBe(fallback);

    // Status 429 alone (no `error: rate_limited`) should still trigger the
    // retry-window copy because the server contract is HTTP-level.
    expect(mapOtpSendErrorToCopy({
      status: 429,
      body: { ok: false, retryAfterSeconds: 600 },
    })).toBe('Too many attempts. Please try again in about 10 minutes.');
  });

  it('keeps stable provider error codes mapped to polished generic copy', async () => {
    const { mapOtpSendErrorToCopy, OTP_SEND_ERROR_COPY } = await importPhoneOtpSession();

    // Direct string codes.
    expect(mapOtpSendErrorToCopy('SMS_SEND_FAILED')).toBe(OTP_SEND_ERROR_COPY.SMS_SEND_FAILED);
    expect(mapOtpSendErrorToCopy('SMS_PROVIDER_REJECTED')).toBe(OTP_SEND_ERROR_COPY.SMS_PROVIDER_REJECTED);
    expect(mapOtpSendErrorToCopy('OTP_SERVICE_UNAVAILABLE')).toBe(OTP_SEND_ERROR_COPY.OTP_SERVICE_UNAVAILABLE);
    expect(mapOtpSendErrorToCopy('SMS_PROVIDER_MISCONFIGURED')).toBe(OTP_SEND_ERROR_COPY.SMS_PROVIDER_MISCONFIGURED);

    // ApiError-shaped objects.
    expect(mapOtpSendErrorToCopy({
      status: 502,
      body: { ok: false, error: 'SMS_SEND_FAILED' },
    })).toBe(OTP_SEND_ERROR_COPY.SMS_SEND_FAILED);
    expect(mapOtpSendErrorToCopy({
      status: 503,
      body: { ok: false, error: 'SMS_PROVIDER_MISCONFIGURED' },
    })).toBe(OTP_SEND_ERROR_COPY.SMS_PROVIDER_MISCONFIGURED);

    // Unknown codes return null so callers can pick a generic fallback.
    expect(mapOtpSendErrorToCopy('SOMETHING_NEW')).toBeNull();
    expect(mapOtpSendErrorToCopy({ status: 418, body: { error: 'TEAPOT' } })).toBeNull();
    expect(mapOtpSendErrorToCopy(null)).toBeNull();
    expect(mapOtpSendErrorToCopy(undefined)).toBeNull();
  });

  it('never echoes raw server-supplied strings (only frozen, polished copy)', async () => {
    const { mapOtpSendErrorToCopy } = await importPhoneOtpSession();

    // An attacker controlling the response body should NOT be able to inject
    // arbitrary text into the UI via the error mapping. Unknown codes -> null,
    // and rate_limited uses a hard-coded template with only the minute number
    // from retryAfterSeconds (a numeric coercion).
    const malicious = {
      status: 429,
      body: {
        error: 'rate_limited',
        retryAfterSeconds: '<script>alert(1)</script>',
        message: '<img src=x onerror=alert(1)>',
      },
    };
    const copy = mapOtpSendErrorToCopy(malicious);
    expect(copy).toMatch(/^Too many attempts\. Please try again in a few minutes\.$/);
    expect(copy).not.toMatch(/<|>|script|alert|onerror/i);
  });

  it('strict env disables local demo phone OTP even on local', async () => {
    const { completeCustomPhoneOtpVerification } = await importPhoneOtpSession({
      VITE_APP_ENV: 'local',
      VITE_ALLOW_CLIENT_DEMO_CONTROLS: 'true',
      VITE_STRICT_ENV: 'true',
    });
    const supabase = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      },
    };

    await expect(completeCustomPhoneOtpVerification(supabase, '+254712345678'))
      .rejects.toMatchObject({ code: 'PHONE_OTP_SESSION_REQUIRED' });
  });
});
