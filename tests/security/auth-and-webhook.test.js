import { describe, it, expect } from 'vitest';
import {
  verifyWebhookSignature,
  hmacSha256,
  TIMESTAMP_TOLERANCE_SECONDS,
} from '../../supabase/functions/_shared/webhook-verify.ts';
import { getRouteProtection, requiresAdmin } from '@/lib/routeGuard.js';
import { createClient } from '@supabase/supabase-js';

describe('security — webhook replay & forgery', () => {
  const secret = 'daraja-prod-secret';
  const rawPayload = '{"Body":{"stkCallback":{"ResultCode":0}}}';

  it('tampered payload is rejected end-to-end (signature mismatch)', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const goodSig = await hmacSha256(secret, `${ts}.${rawPayload}`);
    const tampered = rawPayload.replace('"ResultCode":0', '"ResultCode":1');
    const r = await verifyWebhookSignature(tampered, goodSig, ts, secret);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('signature_mismatch');
  });

  it('replayed callback with a stale timestamp is rejected even with a valid HMAC', async () => {
    const staleTs = String(Math.floor(Date.now() / 1000) - TIMESTAMP_TOLERANCE_SECONDS - 1);
    const staleSig = await hmacSha256(secret, `${staleTs}.${rawPayload}`);
    const r = await verifyWebhookSignature(rawPayload, staleSig, staleTs, secret);
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('timestamp_expired');
  });

  it('callback with no secret configured is rejected regardless of signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const r = await verifyWebhookSignature(rawPayload, 'any-sig', ts, '');
    expect(r.valid).toBe(false);
    expect(r.reason).toBe('no_secret_configured');
  });
});

describe('security — route guard prefix and defaults', () => {
  it('unknown path defaults to auth (never public)', () => {
    const p = getRouteProtection('/unknown-operational-path-z9');
    expect(p.level).toBe('auth');
    expect(requiresAdmin('/unknown-operational-path-z9')).toBe(false);
  });

  it('nested admin URLs inherit admin protection (no bypass via subpath)', () => {
    expect(getRouteProtection('/admin/users').level).toBe('admin');
    expect(requiresAdmin('/admin/users')).toBe(true);
  });
});

describe('security — Supabase JWT shape', () => {
  it('getUser rejects malformed JWT string', async () => {
    const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
    const anon = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({})}.x`;
    const c = createClient('https://placeholder.supabase.co', anon, {
      auth: { persistSession: false },
    });
    const { error } = await c.auth.getUser('not-a-valid-jwt');
    expect(error).toBeTruthy();
  });
});
