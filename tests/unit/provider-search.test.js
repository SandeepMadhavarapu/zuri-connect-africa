/**
 * provider-search input validation tests
 *
 * The Edge Function uses npm:zod (Deno-specific import) and Deno globals,
 * so it cannot be imported directly in Vitest/Node. The searchSchema is mirrored
 * here using the npm zod package and exercised against the same six validation
 * rules. Structural assertions on the source file verify the schema is exported
 * from the function and that key security properties hold.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Mirror of the schema exported from supabase/functions/provider-search/index.ts.
// If the Edge Function schema changes, update this mirror to match.
const searchSchema = z.object({
  query: z.string().min(1, 'query required').max(100, 'query too long'),
  method_type: z.enum(['paybill', 'till', 'send_money', 'partner_api']).optional(),
  limit: z
    .number()
    .int()
    .min(1, 'limit must be a positive integer')
    .default(10)
    .transform((v) => Math.min(v, 25)),
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('provider-search: searchSchema validation', () => {
  it('empty query → invalid_input', () => {
    const result = searchSchema.safeParse({ query: '' });
    expect(result.success).toBe(false);
  });

  it('query longer than 100 characters → invalid_input', () => {
    const result = searchSchema.safeParse({ query: 'a'.repeat(101) });
    expect(result.success).toBe(false);
  });

  it('invalid method_type → invalid_input', () => {
    const result = searchSchema.safeParse({ query: 'Safaricom', method_type: 'wire_transfer' });
    expect(result.success).toBe(false);
  });

  it('valid query with no optional fields → accepts with default limit of 10', () => {
    const result = searchSchema.safeParse({ query: 'Safaricom' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(10);
      expect(result.data.method_type).toBeUndefined();
    }
  });

  it('limit > 25 → clamped to 25', () => {
    const result = searchSchema.safeParse({ query: 'KRA', limit: 50 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(25);
    }
  });

  it('negative limit → invalid_input', () => {
    const result = searchSchema.safeParse({ query: 'KRA', limit: -1 });
    expect(result.success).toBe(false);
  });
});

// ── Edge case coverage ─────────────────────────────────────────────────────────

describe('provider-search: searchSchema edge cases', () => {
  it('limit = 0 → invalid_input', () => {
    const result = searchSchema.safeParse({ query: 'KRA', limit: 0 });
    expect(result.success).toBe(false);
  });

  it('limit exactly 25 → accepted unchanged', () => {
    const result = searchSchema.safeParse({ query: 'KRA', limit: 25 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(25);
  });

  it('all valid method_type values are accepted', () => {
    for (const mt of ['paybill', 'till', 'send_money', 'partner_api']) {
      const result = searchSchema.safeParse({ query: 'x', method_type: mt });
      expect(result.success).toBe(true);
    }
  });

  it('query exactly 100 characters → valid', () => {
    const result = searchSchema.safeParse({ query: 'a'.repeat(100) });
    expect(result.success).toBe(true);
  });
});

// ── Source-level structural assertions ────────────────────────────────────────

describe('provider-search: Edge Function source structure', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'supabase/functions/provider-search/index.ts'),
    'utf8',
  );

  it('exports searchSchema for unit testing', () => {
    expect(src).toMatch(/export\s+const\s+searchSchema/);
  });

  it('exports SearchInput type', () => {
    expect(src).toMatch(/export\s+type\s+SearchInput/);
  });

  it('imports Zod via npm: specifier for Deno compatibility', () => {
    expect(src).toMatch(/from\s+['"]npm:zod['"]/);
  });

  it('handles OPTIONS preflight', () => {
    expect(src).toMatch(/req\.method.*===.*['"]OPTIONS['"]/);
  });

  it('returns 401 for unauthorized access', () => {
    expect(src).toMatch(/\b401\b/);
  });

  it('returns 429 when rate limit is exceeded', () => {
    expect(src).toMatch(/\b429\b/);
    expect(src).toMatch(/rate_limited/);
  });

  it('returns database_error on 500 without leaking raw error to client', () => {
    expect(src).toMatch(/database_error/);
    // Must not pass error.message directly into the client-facing json() response.
    expect(src).not.toMatch(/json\(\s*\{[^}]*error\.message/);
  });

  it('logs user_id and result_count but not the full result rows', () => {
    expect(src).toMatch(/user_id/);
    expect(src).toMatch(/result_count/);
    // The full results array must not be passed as a top-level console argument.
    expect(src).not.toMatch(/console\.(log|info)\(\s*results\s*\)/);
    expect(src).not.toMatch(/console\.(log|info)\(\s*JSON\.stringify\(\s*results\s*\)/);
  });

  it('uses user JWT client (ANON_KEY) for data reads — not service role', () => {
    expect(src).toMatch(/SUPABASE_ANON_KEY/);
    // The user JWT client must use the Authorization header from the request.
    expect(src).toMatch(/Authorization.*authHeader|authHeader.*Authorization/);
  });

  it('reuses _shared/auth requireAuth helper — no inline JWT reimplementation', () => {
    expect(src).toMatch(/requireAuth/);
    expect(src).toMatch(/isAuthResult/);
  });

  it('reuses _shared/rate-limit checkRateLimit helper', () => {
    expect(src).toMatch(/checkRateLimit/);
  });
});
