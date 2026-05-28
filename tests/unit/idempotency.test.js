import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateIdempotencyKey,
  checkIdempotency,
  recordIdempotency,
  clearExpiredKeys,
} from '@/lib/idempotency.js';

describe('idempotency', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('generateIdempotencyKey is stable within TTL bucket', () => {
    const a = generateIdempotencyKey('u1', 'send_money', 500);
    const b = generateIdempotencyKey('u1', 'send_money', 500);
    expect(a).toBe(b);
    expect(a.startsWith('zuri_idmp_')).toBe(true);
  });

  it('record and replay idempotent result', () => {
    const key = generateIdempotencyKey('u', 'test', 1);
    expect(checkIdempotency(key)).toBeNull();
    recordIdempotency(key, { ok: true, ref: 'R1' });
    expect(checkIdempotency(key)).toEqual({ ok: true, ref: 'R1' });
  });

  it('clearExpiredKeys removes stale entries', () => {
    const key = 'zuri_idmp_manual';
    sessionStorage.setItem(
      key,
      JSON.stringify({
        key,
        result: { x: 1 },
        recordedAt: 0,
        expiresAt: Date.now() - 1000,
      })
    );
    clearExpiredKeys();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
