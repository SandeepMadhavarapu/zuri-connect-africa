import { describe, it, expect, beforeEach } from 'vitest';
import { generateIdempotencyKey, checkIdempotency, recordIdempotency, clearExpiredKeys } from '@/lib/idempotency.js';

describe('idempotency stress — duplicate suppression', () => {
  beforeEach(() => {
    sessionStorage.clear();
    clearExpiredKeys();
  });

  it('concurrent logical keys collapse to one recorded result', () => {
    const key = generateIdempotencyKey('+254700', 'send_money', 2500);
    expect(checkIdempotency(key)).toBeNull();
    const result = { txRef: 'TX-STORM', ok: true };
    for (let i = 0; i < 50; i++) {
      if (checkIdempotency(key)) break;
      recordIdempotency(key, result);
    }
    expect(checkIdempotency(key)).toEqual(result);
  });
});
