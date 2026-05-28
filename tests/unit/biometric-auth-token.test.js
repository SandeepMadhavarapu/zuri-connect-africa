import { beforeEach, describe, expect, it, vi } from 'vitest';

const SERVER_CHALLENGE = 'dGVzdC1jaGFsbGVuZ2U';
const SERVER_RP_ID = 'zuri.local';
const SERVER_RP_NAME = 'Zuri Connect Africa';

function installWebAuthnMocks() {
  class MockPublicKeyCredential {}
  MockPublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = vi.fn(() => Promise.resolve(true));

  Object.defineProperty(window, 'PublicKeyCredential', {
    value: MockPublicKeyCredential,
    configurable: true,
  });

  const spkiBytes = new Uint8Array([9, 8, 7, 6]).buffer;
  const credential = {
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    response: {
      getPublicKey: vi.fn(() => spkiBytes),
      getPublicKeyAlgorithm: vi.fn(() => -7),
      clientDataJSON: new Uint8Array([5, 6, 7, 8]).buffer,
      attestationObject: new Uint8Array([9, 10, 11, 12]).buffer,
    },
  };

  const createSpy = vi.fn(() => Promise.resolve(credential));
  Object.defineProperty(navigator, 'credentials', {
    value: { create: createSpy, get: vi.fn() },
    configurable: true,
  });

  return { createSpy, credential };
}

function mockRegistrationFetch() {
  return vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'get_registration_options') {
      return {
        ok: true,
        json: () => Promise.resolve({
          challenge: SERVER_CHALLENGE,
          challenge_id: 'challenge-row-1',
          rp_id: SERVER_RP_ID,
          rp_name: SERVER_RP_NAME,
        }),
      };
    }
    if (body.action === 'register') {
      return { ok: true, json: () => Promise.resolve({ ok: true }) };
    }
    return { ok: false, json: () => Promise.resolve({ error: 'unknown_action' }) };
  });
}

describe('biometric auth token handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    localStorage.clear();
  });

  it('registration first calls get_registration_options with bearer token', async () => {
    const { createSpy } = installWebAuthnMocks();
    global.fetch = mockRegistrationFetch();
    const exportKeySpy = vi.spyOn(crypto.subtle, 'exportKey');

    const { registerBiometric } = await import('@/lib/biometricAuth.js');
    const result = await registerBiometric('user@example.com', 'Test User', 'session-token-123');

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body).action).toBe('get_registration_options');
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer session-token-123');
    expect(exportKeySpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('navigator.credentials.create uses server challenge and rp_id/rp_name', async () => {
    const { createSpy } = installWebAuthnMocks();
    global.fetch = mockRegistrationFetch();

    const { registerBiometric } = await import('@/lib/biometricAuth.js');
    await registerBiometric('user@example.com', 'Test User', 'session-token-123');

    const options = createSpy.mock.calls[0][0].publicKey;
    expect(new Uint8Array(options.challenge)).toEqual(new Uint8Array([116, 101, 115, 116, 45, 99, 104, 97, 108, 108, 101, 110, 103, 101]));
    expect(options.rp).toEqual({ id: SERVER_RP_ID, name: SERVER_RP_NAME });
    expect(options.rp.id).toBe(SERVER_RP_ID);
    expect(options.rp.name).toBe(SERVER_RP_NAME);
  });

  it('register payload includes challenge_id, client_data_json, and attestation_object', async () => {
    installWebAuthnMocks();
    global.fetch = mockRegistrationFetch();

    const { registerBiometric } = await import('@/lib/biometricAuth.js');
    await registerBiometric('user@example.com', 'Test User', 'session-token-123');

    const registerBody = JSON.parse(fetch.mock.calls[1][1].body);
    expect(registerBody).toMatchObject({
      action: 'register',
      challenge_id: 'challenge-row-1',
      algorithm: -7,
    });
    expect(registerBody.credential_id).toBeTruthy();
    expect(registerBody.public_key_spki).toBeTruthy();
    expect(registerBody.client_data_json).toBeTruthy();
    expect(registerBody.attestation_object).toBeTruthy();
  });

  it('uses getPublicKey bytes directly without invalid exportKey on ArrayBuffer', async () => {
    const { credential } = installWebAuthnMocks();
    global.fetch = mockRegistrationFetch();
    const exportKeySpy = vi.spyOn(crypto.subtle, 'exportKey');

    const { registerBiometric } = await import('@/lib/biometricAuth.js');
    await registerBiometric('user@example.com', 'Test User', 'session-token-123');

    expect(credential.response.getPublicKey).toHaveBeenCalled();
    expect(exportKeySpy).not.toHaveBeenCalled();
    const registerBody = JSON.parse(fetch.mock.calls[1][1].body);
    // SPKI bytes [9,8,7,6] -> base64url 'CQgHBg' (no padding, URL-safe alphabet).
    expect(registerBody.public_key_spki).toBe('CQgHBg');
  });

  it('serializes all binary register fields as base64url derived from raw ArrayBuffer bytes', async () => {
    installWebAuthnMocks();
    global.fetch = mockRegistrationFetch();

    const { registerBiometric } = await import('@/lib/biometricAuth.js');
    await registerBiometric('user@example.com', 'Test User', 'session-token-123');

    const registerBody = JSON.parse(fetch.mock.calls[1][1].body);
    // base64url: URL-safe alphabet (-_) and no '=' padding.
    const isBase64Url = (s) => /^[A-Za-z0-9_-]+$/.test(s);
    expect(isBase64Url(registerBody.credential_id)).toBe(true);
    expect(isBase64Url(registerBody.public_key_spki)).toBe(true);
    expect(isBase64Url(registerBody.client_data_json)).toBe(true);
    expect(isBase64Url(registerBody.attestation_object)).toBe(true);
    expect(registerBody.credential_id).toBe('AQIDBA');             // [1,2,3,4]
    expect(registerBody.client_data_json).toBe('BQYHCA');          // [5,6,7,8]
    expect(registerBody.attestation_object).toBe('CQoLDA');        // [9,10,11,12]
    expect(registerBody.attestation_object).not.toContain('=');
    expect(typeof registerBody.client_data_json).toBe('string');
    // Critical: must not be JSON-stringified objects or "[object ArrayBuffer]".
    expect(registerBody.attestation_object).not.toMatch(/object|ArrayBuffer/);
  });

  it('biometric enrollment fails closed when session token is missing', async () => {
    installWebAuthnMocks();
    global.fetch = mockRegistrationFetch();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { registerBiometric, BIOMETRIC_SESSION_REQUIRED_MESSAGE } = await import('@/lib/biometricAuth.js');

    const result = await registerBiometric('user@example.com', 'Test User');

    expect(result).toMatchObject({
      success: false,
      code: 'BIOMETRIC_SESSION_REQUIRED',
      error: BIOMETRIC_SESSION_REQUIRED_MESSAGE,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('maps server config errors to safe user message', async () => {
    installWebAuthnMocks();
    global.fetch = vi.fn(() => Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ error: 'webauthn_rp_id_origin_mismatch' }),
    }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { registerBiometric } = await import('@/lib/biometricAuth.js');
    const result = await registerBiometric('user@example.com', 'Test User', 'session-token-123');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Biometric setup is not configured for this app origin.');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('session-token-123');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SERVER_CHALLENGE);
  });

  it('does not log tokens, challenges, or attestation payloads on failure', async () => {
    installWebAuthnMocks();
    global.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'get_registration_options') {
        return {
          ok: true,
          json: () => Promise.resolve({
            challenge: SERVER_CHALLENGE,
            challenge_id: 'challenge-row-1',
            rp_id: SERVER_RP_ID,
            rp_name: SERVER_RP_NAME,
          }),
        };
      }
      return { ok: false, json: () => Promise.resolve({ error: 'registration_fields_missing' }) };
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { registerBiometric } = await import('@/lib/biometricAuth.js');
    await registerBiometric('user@example.com', 'Test User', 'secret-session-token');

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('secret-session-token');
    expect(logged).not.toContain(SERVER_CHALLENGE);
    expect(logged).not.toContain('attestationObject');
  });

  it('formatBiometricEnrolledLabel returns a clean date label or safe fallback', async () => {
    const {
      formatBiometricEnrolledLabel,
      BIOMETRIC_ENROLLED_FALLBACK_LABEL,
    } = await import('@/lib/biometricAuth.js');

    // Valid ISO date — must produce "Enrolled <something>" and never "Invalid Date".
    const valid = formatBiometricEnrolledLabel('2026-05-19T08:30:00.000Z');
    expect(valid).toMatch(/^Enrolled\s+\S+/);
    expect(valid).not.toMatch(/Invalid Date/);

    // Valid Date object.
    expect(formatBiometricEnrolledLabel(new Date('2026-05-19T08:30:00.000Z'))).toMatch(/^Enrolled\s+\S+/);

    // Missing / empty / invalid inputs — all fall back, never "Invalid Date".
    expect(formatBiometricEnrolledLabel(null)).toBe(BIOMETRIC_ENROLLED_FALLBACK_LABEL);
    expect(formatBiometricEnrolledLabel(undefined)).toBe(BIOMETRIC_ENROLLED_FALLBACK_LABEL);
    expect(formatBiometricEnrolledLabel('')).toBe(BIOMETRIC_ENROLLED_FALLBACK_LABEL);
    expect(formatBiometricEnrolledLabel('not-a-date')).toBe(BIOMETRIC_ENROLLED_FALLBACK_LABEL);
    expect(formatBiometricEnrolledLabel(NaN)).toBe(BIOMETRIC_ENROLLED_FALLBACK_LABEL);
  });

  it('successful registration persists enrolledAt and getBiometricEnrollmentInfo surfaces it', async () => {
    installWebAuthnMocks();
    global.fetch = mockRegistrationFetch();

    const {
      registerBiometric,
      getBiometricEnrollmentInfo,
    } = await import('@/lib/biometricAuth.js');

    const before = Date.now();
    const result = await registerBiometric('user@example.com', 'Test User', 'session-token-123');
    const after = Date.now();

    expect(result.success).toBe(true);
    expect(typeof result.enrolledAt).toBe('string');
    const enrolledAtMs = new Date(result.enrolledAt).getTime();
    expect(Number.isNaN(enrolledAtMs)).toBe(false);
    expect(enrolledAtMs).toBeGreaterThanOrEqual(before);
    expect(enrolledAtMs).toBeLessThanOrEqual(after);

    const info = await getBiometricEnrollmentInfo('user@example.com');
    expect(info).toMatchObject({ enrolled: true });
    expect(info.enrolledAt).toBe(result.enrolledAt);
  });

  it('getBiometricEnrollmentInfo returns enrolledAt: null for legacy enrollments (no Invalid Date)', async () => {
    // Simulate a user enrolled BEFORE this fix: credential_id key exists but no
    // biometric_enrolled_at_<userId> key. The component must show the fallback.
    localStorage.setItem('biometric_cred_id_legacy@example.com', 'legacy-cred-id');

    const {
      getBiometricEnrollmentInfo,
      formatBiometricEnrolledLabel,
      BIOMETRIC_ENROLLED_FALLBACK_LABEL,
    } = await import('@/lib/biometricAuth.js');

    const info = await getBiometricEnrollmentInfo('legacy@example.com');
    expect(info.enrolled).toBe(true);
    expect(info.enrolledAt).toBeNull();
    expect(formatBiometricEnrolledLabel(info.enrolledAt)).toBe(BIOMETRIC_ENROLLED_FALLBACK_LABEL);
  });

  it('clearBiometricEnrollment removes both credential id and enrolledAt keys', async () => {
    localStorage.setItem('biometric_cred_id_user@example.com', 'cred-id-xyz');
    localStorage.setItem('biometric_enrolled_at_user@example.com', '2026-05-19T08:30:00.000Z');

    const { clearBiometricEnrollment } = await import('@/lib/biometricAuth.js');
    const result = await clearBiometricEnrollment('user@example.com');

    expect(result.success).toBe(true);
    expect(localStorage.getItem('biometric_cred_id_user@example.com')).toBeNull();
    expect(localStorage.getItem('biometric_enrolled_at_user@example.com')).toBeNull();
  });

  it('local biometric demo policy works only when demo controls are explicitly allowed', async () => {
    const { computeClientDemoPolicy } = await import('@/config/clientSecurityPolicy.js');

    expect(computeClientDemoPolicy({
      appEnv: 'local',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
    }).allowBiometricClientSimulation).toBe(true);

    expect(computeClientDemoPolicy({
      appEnv: 'local',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: false,
    }).allowBiometricClientSimulation).toBe(false);

    expect(computeClientDemoPolicy({
      appEnv: 'production',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
    }).allowBiometricClientSimulation).toBe(false);
  });
});
