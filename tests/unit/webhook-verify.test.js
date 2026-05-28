import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature,
  hmacSha256,
  sha256Hex,
  constantTimeEqual,
  TIMESTAMP_TOLERANCE_SECONDS,
} from '../../supabase/functions/_shared/webhook-verify.ts';

describe('helpers — sha256Hex', () => {
  it('empty string yields the well-known SHA-256 digest', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb924' +
      '27ae41e4649b934ca495991b7852b855'
    );
  });
});

describe('helpers — hmacSha256', () => {
  it('matches node:crypto HMAC-SHA-256 for a fixed key and message', async () => {
    const key = 'whsec_test_key_123';
    const msg = '{"hello":"world"}';
    const expected = createHmac('sha256', key).update(msg).digest('hex');
    expect(await hmacSha256(key, msg)).toBe(expected);
  });
});

describe('helpers — constantTimeEqual', () => {
  it('equal strings return true', () => {
    expect(constantTimeEqual('abc123', 'abc123')).toBe(true);
  });

  it('strings of different length return false', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });

  it('same-length strings with different content return false', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'test-webhook-secret';
  const body = '{"ResultCode":0}';

  it('returns missing_signature when signatureHeader is null', async () => {
    expect(await verifyWebhookSignature(body, null, null, secret))
      .toEqual({ valid: false, reason: 'missing_signature' });
  });

  it('returns no_secret_configured when secret is empty string', async () => {
    expect(await verifyWebhookSignature(body, 'sig', null, ''))
      .toEqual({ valid: false, reason: 'no_secret_configured' });
  });

  it('returns invalid_timestamp when timestampHeader is not a finite number', async () => {
    expect(await verifyWebhookSignature(body, 'sig', 'not-a-number', secret))
      .toEqual({ valid: false, reason: 'invalid_timestamp' });
  });

  it('returns timestamp_expired when timestamp is older than TIMESTAMP_TOLERANCE_SECONDS', async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - TIMESTAMP_TOLERANCE_SECONDS - 1);
    expect(await verifyWebhookSignature(body, 'sig', staleTs, secret))
      .toEqual({ valid: false, reason: 'timestamp_expired' });
  });

  it('returns timestamp_expired when timestamp is far in the future', async () => {
    const futureTs = String(Math.floor(Date.now() / 1000) + TIMESTAMP_TOLERANCE_SECONDS + 3600);
    expect(await verifyWebhookSignature(body, 'sig', futureTs, secret))
      .toEqual({ valid: false, reason: 'timestamp_expired' });
  });

  it('accepts a correctly-computed HMAC over timestamp.body when timestamp is present', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await hmacSha256(secret, `${ts}.${body}`);
    expect(await verifyWebhookSignature(body, sig, ts, secret)).toEqual({ valid: true });
  });

  it('accepts a correctly-computed HMAC over body alone when timestamp is null', async () => {
    const sig = await hmacSha256(secret, body);
    expect(await verifyWebhookSignature(body, sig, null, secret)).toEqual({ valid: true });
  });

  it('returns signature_mismatch when signature does not match', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    // 'deadbeef' × 8 = 64-char hex string, same length as a real HMAC-SHA256 digest
    expect(await verifyWebhookSignature(body, 'deadbeef'.repeat(8), ts, secret))
      .toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('strips a leading sha256= prefix from the received signature before comparison', async () => {
    const sig = await hmacSha256(secret, body);
    expect(await verifyWebhookSignature(body, `sha256=${sig}`, null, secret))
      .toEqual({ valid: true });
  });
});
