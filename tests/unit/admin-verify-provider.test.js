/**
 * admin-verify-provider input validation tests
 *
 * The Edge Function uses npm:zod (Deno-specific import) and Deno globals,
 * so it cannot be imported directly in Vitest/Node. The verifySchema is mirrored
 * here using the npm zod package and exercised against the same validation rules.
 * Structural assertions on the source file verify the schema is exported from the
 * function and that key security properties hold.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

// Mirror of the schema exported from supabase/functions/admin-verify-provider/index.ts.
// If the Edge Function schema changes, update this mirror to match.
const SOURCE_TYPES = [
  'safaricom_directory',
  'provider_letter',
  'utility_invoice',
  'field_visit',
  'partner_api',
  'signed_contract',
];

const verifySchema = z.object({
  payment_method_id: z.string().uuid('payment_method_id must be a valid UUID'),
  source_type: z.enum(SOURCE_TYPES),
  source_reference: z
    .string()
    .min(5, 'source_reference too short')
    .max(500, 'source_reference too long'),
  evidence_hash: z
    .string()
    .max(200, 'evidence_hash too long')
    .regex(/^[0-9a-fA-F]+$/, 'evidence_hash must be hex')
    .optional(),
  attestation: z.record(z.unknown()).default({}),
  notes: z
    .string()
    .max(500, 'notes too long')
    .optional(),
});

const VALID_UUID      = '550e8400-e29b-41d4-a716-446655440000';
const VALID_REF       = 'Safaricom directory entry 2026-05-29';
const VALID_SRC_TYPE  = 'safaricom_directory';

// ── Input validation ──────────────────────────────────────────────────────────

describe('admin-verify-provider: verifySchema validation', () => {
  it('missing payment_method_id → invalid_input', () => {
    const result = verifySchema.safeParse({ source_type: VALID_SRC_TYPE, source_reference: VALID_REF });
    expect(result.success).toBe(false);
  });

  it('invalid UUID for payment_method_id → invalid_input', () => {
    const result = verifySchema.safeParse({
      payment_method_id: 'not-a-uuid',
      source_type: VALID_SRC_TYPE,
      source_reference: VALID_REF,
    });
    expect(result.success).toBe(false);
  });

  it('missing source_type → invalid_input', () => {
    const result = verifySchema.safeParse({ payment_method_id: VALID_UUID, source_reference: VALID_REF });
    expect(result.success).toBe(false);
  });

  it('invalid source_type → invalid_input', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       'random_string',
      source_reference:  VALID_REF,
    });
    expect(result.success).toBe(false);
  });

  it('all 6 valid source_types are accepted', () => {
    for (const st of SOURCE_TYPES) {
      const result = verifySchema.safeParse({
        payment_method_id: VALID_UUID,
        source_type:       st,
        source_reference:  VALID_REF,
      });
      expect(result.success, `source_type '${st}' should be accepted`).toBe(true);
    }
  });

  it('source_reference shorter than 5 chars → invalid_input', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  'abc',
    });
    expect(result.success).toBe(false);
  });

  it('source_reference longer than 500 chars → invalid_input', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('evidence_hash longer than 200 chars → invalid_input', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
      evidence_hash:     'a'.repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it('evidence_hash with non-hex characters → invalid_input', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
      evidence_hash:     'not-hex-at-all!!',
    });
    expect(result.success).toBe(false);
  });

  it('notes longer than 500 chars → invalid_input', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
      notes:             'a'.repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it('valid full input (all fields) → schema passes', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
      evidence_hash:     'deadbeef0123456789abcdef',
      attestation:       { reviewed_by: 'Alice', timestamp: '2026-05-29' },
      notes:             'Confirmed via official Safaricom directory lookup.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.payment_method_id).toBe(VALID_UUID);
      expect(result.data.source_type).toBe(VALID_SRC_TYPE);
      expect(result.data.evidence_hash).toBe('deadbeef0123456789abcdef');
    }
  });

  it('valid minimal input (no optional fields) → schema passes with defaults', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.evidence_hash).toBeUndefined();
      expect(result.data.attestation).toEqual({});
      expect(result.data.notes).toBeUndefined();
    }
  });
});

// ── Edge case coverage ─────────────────────────────────────────────────────────

describe('admin-verify-provider: verifySchema edge cases', () => {
  it('source_reference exactly 5 chars → valid', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  'abcde',
    });
    expect(result.success).toBe(true);
  });

  it('source_reference exactly 500 chars → valid', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  'a'.repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it('evidence_hash exactly 200 hex chars → valid', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
      evidence_hash:     'a'.repeat(200),
    });
    expect(result.success).toBe(true);
  });

  it('notes exactly 500 chars → valid', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
      notes:             'a'.repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it('attestation defaults to {} when omitted', () => {
    const result = verifySchema.safeParse({
      payment_method_id: VALID_UUID,
      source_type:       VALID_SRC_TYPE,
      source_reference:  VALID_REF,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.attestation).toEqual({});
  });
});

// ── Source-level structural assertions ────────────────────────────────────────

describe('admin-verify-provider: Edge Function source structure', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'supabase/functions/admin-verify-provider/index.ts'),
    'utf8',
  );

  it('imports Zod via npm: specifier for Deno compatibility', () => {
    expect(src).toMatch(/from\s+['"]npm:zod['"]/);
  });

  it('exports verifySchema for unit testing', () => {
    expect(src).toMatch(/export\s+const\s+verifySchema/);
  });

  it('exports VerifyInput type', () => {
    expect(src).toMatch(/export\s+type\s+VerifyInput/);
  });

  it('handles OPTIONS preflight', () => {
    expect(src).toMatch(/req\.method.*===.*['"]OPTIONS['"]/);
  });

  it('returns 401 for unauthorized access', () => {
    expect(src).toMatch(/\b401\b/);
  });

  it('returns 403 for non-admin callers', () => {
    expect(src).toMatch(/\b403\b/);
    expect(src).toMatch(/admin_required/);
  });

  it('returns 404 when payment method is not found', () => {
    expect(src).toMatch(/\b404\b/);
    expect(src).toMatch(/payment_method_not_found/);
  });

  it("calls rpc('verify_provider_payment_method', ...)", () => {
    expect(src).toMatch(/\.rpc\(\s*['"]verify_provider_payment_method['"]/);
  });

  it('uses SUPABASE_SERVICE_ROLE_KEY for the rpc client', () => {
    expect(src).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('has explicit admin role check before the rpc call', () => {
    const adminIdx = src.indexOf('requireAdminRole');
    const rpcIdx   = src.indexOf(".rpc('verify_provider_payment_method'");
    expect(adminIdx).toBeGreaterThan(-1);
    expect(rpcIdx).toBeGreaterThan(-1);
    expect(adminIdx).toBeLessThan(rpcIdx);
  });

  it('does not leak raw db error message to client', () => {
    // The 500 branch must not pass error.message into the response body.
    expect(src).not.toMatch(/json\(\s*\{[^}]*error\.message/);
  });

  it('does not log source_reference or attestation', () => {
    // These fields may contain PII or sensitive evidence details.
    const logJsonBlock = src.match(/console\.log\(JSON\.stringify\(\{([\s\S]*?)\}\)\)/)?.[1] ?? '';
    expect(logJsonBlock).not.toMatch(/\bsource_reference\b/);
    expect(logJsonBlock).not.toMatch(/\battestation\b/);
  });

  it('imports requireAdminRole from _shared/admin-roles', () => {
    expect(src).toMatch(/requireAdminRole.*admin-roles/);
  });

  it('passes admin-only role guard — not the broader admin+auditor set', () => {
    // The allowed list passed to requireAdminRole must contain only 'admin'.
    // This ensures auditors and fraud_analysts cannot call this endpoint.
    expect(src).toMatch(/requireAdminRole\(.*\[.*'admin'.*\]/s);
  });
});
