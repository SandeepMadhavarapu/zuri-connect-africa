/**
 * report-wrong-number input validation tests
 *
 * The Edge Function uses npm:zod (Deno-specific import) and Deno globals,
 * so it cannot be imported directly in Vitest/Node. The reportSchema is mirrored
 * here using the npm zod package and exercised against the same validation rules.
 * Structural assertions on the source file verify the schema is exported from the
 * function and that key security properties hold.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Mirror of the schema exported from supabase/functions/report-wrong-number/index.ts.
// If the Edge Function schema changes, update this mirror to match.
const reportSchema = z.object({
  payment_method_id: z.string().uuid('payment_method_id must be a valid UUID'),
  alleged_correct_shortcode: z
    .string()
    .max(20, 'alleged_correct_shortcode too long')
    .optional(),
  reason: z
    .string()
    .min(10, 'reason too short')
    .max(500, 'reason too long'),
});

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_REASON = 'This shortcode appears to be incorrect';

// ── Input validation ──────────────────────────────────────────────────────────

describe('report-wrong-number: reportSchema validation', () => {
  it('missing payment_method_id → invalid_input', () => {
    const result = reportSchema.safeParse({ reason: VALID_REASON });
    expect(result.success).toBe(false);
  });

  it('invalid UUID format for payment_method_id → invalid_input', () => {
    const result = reportSchema.safeParse({ payment_method_id: 'not-a-uuid', reason: VALID_REASON });
    expect(result.success).toBe(false);
  });

  it('reason shorter than 10 chars → invalid_input', () => {
    const result = reportSchema.safeParse({ payment_method_id: VALID_UUID, reason: 'Too short' });
    expect(result.success).toBe(false);
  });

  it('reason longer than 500 chars → invalid_input', () => {
    const result = reportSchema.safeParse({ payment_method_id: VALID_UUID, reason: 'a'.repeat(501) });
    expect(result.success).toBe(false);
  });

  it('alleged_correct_shortcode longer than 20 chars → invalid_input', () => {
    const result = reportSchema.safeParse({
      payment_method_id:         VALID_UUID,
      reason:                    VALID_REASON,
      alleged_correct_shortcode: 'a'.repeat(21),
    });
    expect(result.success).toBe(false);
  });

  it('valid input with all fields → schema passes', () => {
    const result = reportSchema.safeParse({
      payment_method_id:         VALID_UUID,
      reason:                    VALID_REASON,
      alleged_correct_shortcode: '174379',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payment_method_id).toBe(VALID_UUID);
      expect(result.data.alleged_correct_shortcode).toBe('174379');
    }
  });

  it('valid input with alleged_correct_shortcode omitted → schema passes', () => {
    const result = reportSchema.safeParse({ payment_method_id: VALID_UUID, reason: VALID_REASON });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.alleged_correct_shortcode).toBeUndefined();
    }
  });
});

// ── Edge case coverage ─────────────────────────────────────────────────────────

describe('report-wrong-number: reportSchema edge cases', () => {
  it('reason exactly 10 chars → valid', () => {
    const result = reportSchema.safeParse({ payment_method_id: VALID_UUID, reason: 'a'.repeat(10) });
    expect(result.success).toBe(true);
  });

  it('reason exactly 500 chars → valid', () => {
    const result = reportSchema.safeParse({ payment_method_id: VALID_UUID, reason: 'a'.repeat(500) });
    expect(result.success).toBe(true);
  });

  it('alleged_correct_shortcode exactly 20 chars → valid', () => {
    const result = reportSchema.safeParse({
      payment_method_id:         VALID_UUID,
      reason:                    VALID_REASON,
      alleged_correct_shortcode: 'a'.repeat(20),
    });
    expect(result.success).toBe(true);
  });

  it('missing reason field → invalid_input', () => {
    const result = reportSchema.safeParse({ payment_method_id: VALID_UUID });
    expect(result.success).toBe(false);
  });
});

// ── Source-level structural assertions ────────────────────────────────────────

describe('report-wrong-number: Edge Function source structure', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'supabase/functions/report-wrong-number/index.ts'),
    'utf8',
  );

  it('imports Zod via npm: specifier for Deno compatibility', () => {
    expect(src).toMatch(/from\s+['"]npm:zod['"]/);
  });

  it('exports reportSchema for unit testing', () => {
    expect(src).toMatch(/export\s+const\s+reportSchema/);
  });

  it('exports ReportInput type', () => {
    expect(src).toMatch(/export\s+type\s+ReportInput/);
  });

  it('handles OPTIONS preflight', () => {
    expect(src).toMatch(/req\.method.*===.*['"]OPTIONS['"]/);
  });

  it('returns 401 for unauthorized access', () => {
    expect(src).toMatch(/\b401\b/);
  });

  it('returns 404 when payment method not found', () => {
    expect(src).toMatch(/\b404\b/);
    expect(src).toMatch(/payment_method_not_found/);
  });

  it('returns 429 when daily report limit is exceeded', () => {
    expect(src).toMatch(/\b429\b/);
    expect(src).toMatch(/rate_limited/);
    expect(src).toMatch(/daily_limit_exceeded/);
  });

  it('does not log the reason field', () => {
    // reason text may contain user PII — must not appear inside the log JSON object.
    const logJsonBlock = src.match(/console\.log\(JSON\.stringify\(\{([\s\S]*?)\}\)\)/)?.[1] ?? '';
    expect(logJsonBlock).not.toMatch(/\breason\b/);
  });

  it('uses ANON_KEY + user JWT for rate-limit count and insert — not service_role', () => {
    expect(src).toMatch(/SUPABASE_ANON_KEY/);
    // The Authorization header from the request must be forwarded to the client.
    expect(src).toMatch(/Authorization.*authHeader|authHeader.*Authorization/);
    // The service-role key must not be referenced at all in this function.
    expect(src).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('reuses _shared/auth requireAuth and isAuthResult helpers', () => {
    expect(src).toMatch(/requireAuth/);
    expect(src).toMatch(/isAuthResult/);
  });

  it('rate-limit query targets provider_wrong_number_reports via the user client', () => {
    expect(src).toMatch(/provider_wrong_number_reports/);
    // The count query uses reporter_user_id filter.
    expect(src).toMatch(/reporter_user_id/);
  });
});
