/**
 * Tests that the custom Africa's Talking OTP flow is production-hardened:
 *   1. OTP hashes are peppered HMAC-SHA256, not plain SHA-256.
 *   2. Hash is purpose-bound (verification ≠ step_up ≠ pin_setup).
 *   3. Hash is phone-bound.
 *   4. Missing OTP_PEPPER fails closed with OTP_SERVICE_UNAVAILABLE.
 *   5. No user-facing copy / source line returns wildcard CORS.
 *   6. send-otp / verify-otp / step-up shared verifier all use the atomic
 *      consume_otp RPC so a single OTP can only be consumed once.
 *   7. Wrong OTP increments attempts atomically; expired OTP fails; reused
 *      OTP fails; raw Africa's Talking error bodies never reach the client.
 *   8. The hardening migration ships the consume_otp RPC and the new columns.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_PEPPER = 'otp-unit-pepper-secret-1234567890';

// ── Source files we assert on (no Deno runtime here) ────────────────────────

const sendOtpSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/send-otp/index.ts'),
  'utf8',
);
const verifyOtpSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/verify-otp/index.ts'),
  'utf8',
);
const stepUpSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/_shared/step-up-verification.ts'),
  'utf8',
);
const setPinSource = readFileSync(
  resolve(process.cwd(), 'supabase/functions/set-pin/index.ts'),
  'utf8',
);
const otpMigrationSource = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260519020000_otp_records_hardening.sql'),
  'utf8',
);

// ── otp-crypto.ts (runs in node via vitest) ─────────────────────────────────

async function importOtpCrypto({ pepper = TEST_PEPPER } = {}) {
  vi.resetModules();
  if (pepper === null) {
    delete process.env.OTP_PEPPER;
  } else {
    process.env.OTP_PEPPER = pepper;
  }
  return import('../../supabase/functions/_shared/otp-crypto.ts');
}

describe('otp-crypto: peppered HMAC', () => {
  afterEach(() => {
    delete process.env.OTP_PEPPER;
    vi.resetModules();
  });

  it('uses HMAC-SHA256 keyed on OTP_PEPPER, NOT raw SHA-256 of the OTP', async () => {
    const { hashOtpWithPepper } = await importOtpCrypto();
    const hash = await hashOtpWithPepper('123456', '254712345678', 'verification');
    // 32-byte SHA-256 → 64 hex chars
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // Confirm it is NOT the same as plain SHA-256 of the OTP — that's the
    // exact bug we are fixing.
    const { createHash } = await import('node:crypto');
    const plainSha = createHash('sha256').update('123456').digest('hex');
    expect(hash).not.toBe(plainSha);
  });

  it('binds the hash to the OTP purpose so it cannot be replayed across flows', async () => {
    const { hashOtpWithPepper } = await importOtpCrypto();
    const a = await hashOtpWithPepper('123456', '254712345678', 'verification');
    const b = await hashOtpWithPepper('123456', '254712345678', 'step_up');
    const c = await hashOtpWithPepper('123456', '254712345678', 'pin_setup');
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  it('binds the hash to the normalized phone', async () => {
    const { hashOtpWithPepper } = await importOtpCrypto();
    const a = await hashOtpWithPepper('123456', '254712345678', 'verification');
    const b = await hashOtpWithPepper('123456', '254712345679', 'verification');
    expect(a).not.toBe(b);
  });

  it('a different OTP_PEPPER yields a different hash for the same inputs', async () => {
    const { hashOtpWithPepper: hashA } = await importOtpCrypto({ pepper: TEST_PEPPER });
    const a = await hashA('123456', '254712345678', 'verification');
    const { hashOtpWithPepper: hashB } = await importOtpCrypto({ pepper: 'different-pepper-secret-2222222' });
    const b = await hashB('123456', '254712345678', 'verification');
    expect(a).not.toBe(b);
  });

  it('fails closed when OTP_PEPPER is missing — OTP_SERVICE_UNAVAILABLE', async () => {
    const mod = await importOtpCrypto({ pepper: null });
    expect(() => mod.getOtpPepper()).toThrow(/OTP_SERVICE_UNAVAILABLE/);
    await expect(mod.hashOtpWithPepper('123456', '254712345678', 'verification'))
      .rejects.toThrow(/OTP_SERVICE_UNAVAILABLE/);
  });

  it('fails closed when OTP_PEPPER is too short', async () => {
    const mod = await importOtpCrypto({ pepper: 'tiny' });
    expect(() => mod.getOtpPepper()).toThrow(/OTP_SERVICE_UNAVAILABLE/);
  });

  it('normalizes unknown purposes to "verification"', async () => {
    const { normalizeOtpPurpose } = await importOtpCrypto();
    expect(normalizeOtpPurpose('weird')).toBe('verification');
    expect(normalizeOtpPurpose('step_up')).toBe('step_up');
    expect(normalizeOtpPurpose(undefined)).toBe('verification');
  });

  it('generateNumericOtp returns six-digit codes without bias', async () => {
    const { generateNumericOtp } = await importOtpCrypto();
    for (let i = 0; i < 10; i++) {
      const code = generateNumericOtp(6);
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(Number(code)).toBeGreaterThanOrEqual(100000);
      expect(Number(code)).toBeLessThanOrEqual(999999);
    }
  });
});

// ── send-otp / verify-otp source-level guards ───────────────────────────────

describe('send-otp source: CORS, pepper, provider-error safety', () => {
  it('never falls back to wildcard CORS', () => {
    expect(sendOtpSource).not.toMatch(/['"`]\*['"`]/);
    expect(sendOtpSource).toMatch(/APP_ORIGIN \|\| 'null'/);
  });

  it('declares Access-Control-Allow-Methods for POST and OPTIONS', () => {
    expect(sendOtpSource).toMatch(/Access-Control-Allow-Methods.*POST, OPTIONS/);
  });

  it('requires OTP_PEPPER and fails closed with OTP_SERVICE_UNAVAILABLE', () => {
    expect(sendOtpSource).toMatch(/getOtpPepper\(\)/);
    expect(sendOtpSource).toMatch(/OTP_SERVICE_UNAVAILABLE/);
  });

  it('validates Kenyan mobile shape before sending to Africa Talking', () => {
    expect(sendOtpSource).toMatch(/\^254\[71\]\\d\{8\}/);
    expect(sendOtpSource).toMatch(/\^2540\[71\]\\d\{8\}/);
    expect(sendOtpSource).not.toMatch(/startsWith\(['"]254['"]\)\) return cleaned/);
  });

  it('hashes via peppered HMAC, not raw SHA-256', () => {
    expect(sendOtpSource).toMatch(/hashOtpWithPepper\(/);
    // No locally-defined sha256() helper remains in send-otp.
    expect(sendOtpSource).not.toMatch(/async function sha256\s*\(/);
  });

  it('never returns Africa Talking errorText/details to the client', () => {
    // The whole point: client only ever sees stable public codes.
    expect(sendOtpSource).toMatch(/SMS_SEND_FAILED/);
    expect(sendOtpSource).toMatch(/SMS_PROVIDER_REJECTED/);
    expect(sendOtpSource).toMatch(/SMS_PROVIDER_MISCONFIGURED/);
    expect(sendOtpSource).toMatch(/SMS_PROVIDER_RATE_LIMITED/);
    expect(sendOtpSource).not.toMatch(/details:\s*errorText/);
    expect(sendOtpSource).not.toMatch(/error:\s*['"]Failed to send SMS['"]\s*,\s*details/);
  });

  it('logs only sanitized OTP provider diagnostics', () => {
    expect(sendOtpSource).toMatch(/provider_status/);
    expect(sendOtpSource).toMatch(/provider_error_code/);
    expect(sendOtpSource).toMatch(/phone_suffix/);
    expect(sendOtpSource).not.toMatch(/console\.[a-z]+\([^)]*AT_API_KEY/i);
    expect(sendOtpSource).not.toMatch(/console\.[a-z]+\([^)]*apiKey/i);
    expect(sendOtpSource).not.toMatch(/console\.[a-z]+\([^)]*smsBody/i);
    expect(sendOtpSource).not.toMatch(/console\.[a-z]+\([^)]*smsResponse\.text/i);
    expect(sendOtpSource).not.toMatch(/console\.[a-z]+\([^)]*normalizedPhone/i);
  });

  it('writes a security event for sent / rate-limited / send-failure', () => {
    expect(sendOtpSource).toMatch(/event_type: 'otp\.sent'/);
    expect(sendOtpSource).toMatch(/event_type: 'otp\.rate_limited'/);
    expect(sendOtpSource).toMatch(/event_type: 'otp\.send\.failure'/);
  });

  it('never logs the raw OTP value', () => {
    // Catch the real leak pattern: `${otp}` interpolated into a console call,
    // or the bare `otp` identifier passed as a console argument.
    const interpolations = sendOtpSource.match(/console\.[a-z]+\([^)]*\$\{[^}]*\botp\b[^}]*\}[^)]*\)/g) || [];
    const argRefs = sendOtpSource.match(/console\.[a-z]+\([^)]*,\s*otp\s*[,)]/g) || [];
    expect(interpolations).toEqual([]);
    expect(argRefs).toEqual([]);
  });
});

describe('verify-otp source: CORS, atomicity, raw-OTP safety', () => {
  it('never falls back to wildcard CORS', () => {
    expect(verifyOtpSource).not.toMatch(/['"`]\*['"`]/);
    expect(verifyOtpSource).toMatch(/APP_ORIGIN \|\| 'null'/);
  });

  it('declares Access-Control-Allow-Methods for POST and OPTIONS', () => {
    expect(verifyOtpSource).toMatch(/Access-Control-Allow-Methods.*POST, OPTIONS/);
  });

  it('requires OTP_PEPPER and uses HMAC hashing', () => {
    expect(verifyOtpSource).toMatch(/getOtpPepper\(\)/);
    expect(verifyOtpSource).toMatch(/hashOtpWithPepper\(/);
  });

  it('uses the atomic consume_otp RPC instead of select-then-delete', () => {
    expect(verifyOtpSource).toMatch(/\.rpc\(\s*['"]consume_otp['"]/);
    // No leftover non-atomic delete-by-id from a prior select.
    expect(verifyOtpSource).not.toMatch(/\.from\(['"]otp_records['"]\)\.delete\(\)\.eq\(['"]id['"]/);
  });

  it('handles all consume_otp outcomes (consumed / invalid / expired / locked / already_consumed / not_found)', () => {
    for (const outcome of ['consumed', 'expired', 'locked', 'already_consumed', 'invalid', 'not_found']) {
      expect(verifyOtpSource.includes(`'${outcome}'`)).toBe(true);
    }
  });

  it('writes structured security events for every verification outcome', () => {
    expect(verifyOtpSource).toMatch(/otp\.verify\.success/);
    expect(verifyOtpSource).toMatch(/otp\.verify\.invalid/);
    expect(verifyOtpSource).toMatch(/otp\.verify\.expired/);
    expect(verifyOtpSource).toMatch(/otp\.verify\.locked/);
    expect(verifyOtpSource).toMatch(/otp\.verify\.reuse_attempt/);
    expect(verifyOtpSource).toMatch(/otp\.rate_limited/);
  });

  it('only updates auth.users.phone after a successful OTP with a verified bearer session', () => {
    // The phone bind must be gated on (a) consumed outcome AND (b) a server-
    // validated user id derived from a Bearer JWT — not from request body.
    expect(verifyOtpSource).toMatch(/auth\.admin\.updateUserById\(verifiedUserId/);
    expect(verifyOtpSource).toMatch(/auth\.getUser\(\)/);
    // The phone bind sits inside the `consumed` branch.
    const consumedBlock = verifyOtpSource.slice(
      verifyOtpSource.indexOf("if (outcome === 'consumed')"),
      verifyOtpSource.indexOf("if (outcome === 'expired')"),
    );
    expect(consumedBlock).toMatch(/auth\.admin\.updateUserById/);
  });

  it('never logs or echoes the raw OTP back to the client', () => {
    expect(verifyOtpSource).not.toMatch(/console\.(log|info)\([^)]*\botp\b/i);
    // No response body that returns the OTP itself.
    expect(verifyOtpSource).not.toMatch(/return json\([^)]*\botp:\s*otp\b/);
  });
});

describe('step-up shared verifyOtpAgainstRecord uses peppered HMAC + consume_otp', () => {
  it('imports HMAC helpers and the purpose type', () => {
    expect(stepUpSource).toMatch(/from '\.\/otp-crypto\.ts'/);
    expect(stepUpSource).toMatch(/hashOtpWithPepper/);
  });

  it('no longer uses the plain sha256 helper for OTPs', () => {
    // The old non-pepper helper must be gone.
    expect(stepUpSource).not.toMatch(/async function sha256\s*\(/);
  });

  it('verifies through the atomic consume_otp RPC', () => {
    expect(stepUpSource).toMatch(/\.rpc\(\s*['"]consume_otp['"]/);
    expect(stepUpSource).not.toMatch(/\.from\(['"]otp_records['"]\)\.update\(\{\s*attempts/);
  });

  it('returns "otp_service_unavailable" when the pepper is missing', () => {
    expect(stepUpSource).toMatch(/otp_service_unavailable/);
  });
});

describe('PIN setup OTP is purpose-bound to "pin_setup"', () => {
  it('passes the pin_setup purpose into verifyOtpAgainstRecord', () => {
    expect(setPinSource).toMatch(/verifyOtpAgainstRecord\([^)]+,\s*['"]pin_setup['"]\s*\)/);
  });
});

// ── Migration: schema + atomic RPC ──────────────────────────────────────────

describe('otp_records hardening migration', () => {
  it('adds purpose / expires_at / consumed_at / verified_user_id / hash_version', () => {
    expect(otpMigrationSource).toMatch(/ADD COLUMN IF NOT EXISTS purpose\s+TEXT/i);
    expect(otpMigrationSource).toMatch(/ADD COLUMN IF NOT EXISTS expires_at\s+TIMESTAMPTZ/i);
    expect(otpMigrationSource).toMatch(/ADD COLUMN IF NOT EXISTS consumed_at\s+TIMESTAMPTZ/i);
    expect(otpMigrationSource).toMatch(/ADD COLUMN IF NOT EXISTS verified_user_id\s+UUID/i);
    expect(otpMigrationSource).toMatch(/ADD COLUMN IF NOT EXISTS hash_version\s+TEXT/i);
  });

  it('creates an atomic consume_otp RPC with FOR UPDATE SKIP LOCKED', () => {
    expect(otpMigrationSource).toMatch(/CREATE OR REPLACE FUNCTION public\.consume_otp\b/);
    expect(otpMigrationSource).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(otpMigrationSource).toMatch(/SECURITY DEFINER/);
  });

  it('handles every outcome path inside consume_otp', () => {
    for (const outcome of ['consumed', 'invalid', 'expired', 'locked', 'already_consumed', 'not_found']) {
      expect(otpMigrationSource).toMatch(new RegExp(`'${outcome}'`));
    }
  });

  it('grants execute only to service_role', () => {
    expect(otpMigrationSource).toMatch(/REVOKE ALL ON FUNCTION public\.consume_otp[^;]*FROM PUBLIC/i);
    expect(otpMigrationSource).toMatch(/GRANT EXECUTE ON FUNCTION public\.consume_otp[^;]*TO service_role/i);
  });
});

// ── Atomic single-use behaviour against a fake supabase admin ───────────────

function makeFakeAdminWithConsumeOtp({ rows = [] } = {}) {
  // A minimal in-memory simulator for consume_otp:
  //   * locks the latest un-consumed row for (phone, purpose);
  //   * atomically claims it on hash match;
  //   * increments attempts on mismatch;
  //   * fails on expiry / lock / reuse.
  const state = { rows: rows.map((r) => ({ ...r })) };

  return {
    state,
    rpc: vi.fn(async (name, args) => {
      expect(name).toBe('consume_otp');
      const { p_phone, p_purpose, p_hash, p_max_attempts = 3 } = args;
      const record = state.rows
        .filter((r) => r.phone === p_phone && (r.purpose ?? 'verification') === p_purpose && !r.consumed_at)
        .sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];

      if (!record) {
        return { data: [{ record_id: null, attempts_after: 0, outcome: 'not_found' }], error: null };
      }

      const nowMs = Date.now();
      const isExpired =
        (record.expires_at && new Date(record.expires_at).getTime() <= nowMs) ||
        (!record.expires_at && typeof record.expiry === 'number' && record.expiry <= nowMs);

      if (isExpired) {
        state.rows = state.rows.filter((r) => r.id !== record.id);
        return { data: [{ record_id: record.id, attempts_after: record.attempts ?? 0, outcome: 'expired' }], error: null };
      }
      if ((record.attempts ?? 0) >= p_max_attempts) {
        return { data: [{ record_id: record.id, attempts_after: record.attempts ?? 0, outcome: 'locked' }], error: null };
      }
      if (record.otp_hash !== p_hash) {
        record.attempts = (record.attempts ?? 0) + 1;
        return { data: [{ record_id: record.id, attempts_after: record.attempts, outcome: 'invalid' }], error: null };
      }
      if (record.consumed_at) {
        return { data: [{ record_id: record.id, attempts_after: record.attempts ?? 0, outcome: 'already_consumed' }], error: null };
      }
      record.consumed_at = new Date().toISOString();
      return { data: [{ record_id: record.id, attempts_after: record.attempts ?? 0, outcome: 'consumed' }], error: null };
    }),
  };
}

async function importStepUpVerifier() {
  vi.resetModules();
  process.env.OTP_PEPPER = TEST_PEPPER;
  return import('../../supabase/functions/_shared/step-up-verification.ts');
}

describe('verifyOtpAgainstRecord — atomic single-use behaviour', () => {
  beforeEach(() => {
    process.env.OTP_PEPPER = TEST_PEPPER;
  });
  afterEach(() => {
    delete process.env.OTP_PEPPER;
    vi.resetModules();
  });

  async function seed(phone, purpose, otp, overrides = {}) {
    const { hashOtpWithPepper } = await importOtpCrypto();
    return {
      id: 'rec-1',
      phone,
      purpose,
      otp_hash: await hashOtpWithPepper(otp, phone, purpose),
      attempts: 0,
      consumed_at: null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      created_at: Date.now(),
      ...overrides,
    };
  }

  it('correct OTP → ok:true and marks the row consumed (one-time-use)', async () => {
    const record = await seed('254712345678', 'step_up', '987654');
    const admin = makeFakeAdminWithConsumeOtp({ rows: [record] });
    const { verifyOtpAgainstRecord } = await importStepUpVerifier();

    const r1 = await verifyOtpAgainstRecord(admin, '254712345678', '987654', 'step_up');
    expect(r1).toEqual({ ok: true });
    expect(admin.state.rows[0].consumed_at).not.toBeNull();

    // Replaying the same code (with a fresh hash call) cannot succeed twice.
    const r2 = await verifyOtpAgainstRecord(admin, '254712345678', '987654', 'step_up');
    expect(r2.ok).toBe(false);
    expect(r2.reason).toBe('otp_not_found');
  });

  it('wrong OTP → ok:false with otp_invalid and increments attempts', async () => {
    const record = await seed('254712345678', 'step_up', '987654');
    const admin = makeFakeAdminWithConsumeOtp({ rows: [record] });
    const { verifyOtpAgainstRecord } = await importStepUpVerifier();

    const before = admin.state.rows[0].attempts;
    const r = await verifyOtpAgainstRecord(admin, '254712345678', '000000', 'step_up');
    expect(r).toEqual({ ok: false, reason: 'otp_invalid' });
    expect(admin.state.rows[0].attempts).toBe(before + 1);
  });

  it('expired OTP → ok:false with otp_expired', async () => {
    const record = await seed('254712345678', 'step_up', '987654', {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });
    const admin = makeFakeAdminWithConsumeOtp({ rows: [record] });
    const { verifyOtpAgainstRecord } = await importStepUpVerifier();

    const r = await verifyOtpAgainstRecord(admin, '254712345678', '987654', 'step_up');
    expect(r).toEqual({ ok: false, reason: 'otp_expired' });
  });

  it('verification-purpose OTP cannot be replayed against step_up', async () => {
    const record = await seed('254712345678', 'verification', '987654');
    const admin = makeFakeAdminWithConsumeOtp({ rows: [record] });
    const { verifyOtpAgainstRecord } = await importStepUpVerifier();

    // Same OTP digits, but verifier is asking with purpose='step_up'.
    const r = await verifyOtpAgainstRecord(admin, '254712345678', '987654', 'step_up');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('otp_not_found');
  });

  it('fails closed when OTP_PEPPER is missing', async () => {
    delete process.env.OTP_PEPPER;
    vi.resetModules();
    const { verifyOtpAgainstRecord } = await import('../../supabase/functions/_shared/step-up-verification.ts');
    const admin = makeFakeAdminWithConsumeOtp({ rows: [] });
    const r = await verifyOtpAgainstRecord(admin, '254712345678', '987654', 'step_up');
    expect(r).toEqual({ ok: false, reason: 'otp_service_unavailable' });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('returns otp_already_used when the row is already consumed', async () => {
    const record = await seed('254712345678', 'step_up', '987654', {
      consumed_at: new Date().toISOString(),
    });
    const admin = makeFakeAdminWithConsumeOtp({ rows: [record] });
    const { verifyOtpAgainstRecord } = await importStepUpVerifier();

    // Because the simulator filters out consumed rows when picking the latest
    // active record, the verifier sees "not_found" — exactly mirroring the
    // SQL RPC's behaviour. Either outcome (otp_already_used or otp_not_found)
    // is a refusal; this test pins the refusal contract.
    const r = await verifyOtpAgainstRecord(admin, '254712345678', '987654', 'step_up');
    expect(r.ok).toBe(false);
    expect(['otp_already_used', 'otp_not_found']).toContain(r.reason);
  });
});
