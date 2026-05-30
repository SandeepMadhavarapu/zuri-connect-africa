/**
 * initiate-payment provider directory gate — structural assertions
 *
 * The Edge Function runs under Deno and cannot be imported directly in
 * Vitest/Node. These tests read the source file as text and assert that the
 * gate logic is present, correctly placed, and covers the right payment types.
 * Matching the style of tests/unit/admin-verify-provider.test.js.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SOURCE_PATH = resolve(
  process.cwd(),
  'supabase/functions/initiate-payment/index.ts',
);

describe('initiate-payment: provider directory gate — structural assertions', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');

  // Isolate just the gate block for assertions that must not bleed into
  // unrelated parts of the file (e.g. 'unverified_provider' only in the gate).
  const gateStart = src.indexOf('ZURI_REQUIRE_VERIFIED_PROVIDER');
  const gateEnd   = src.indexOf('End provider directory gate');
  const gateBlock = gateStart !== -1 && gateEnd !== -1
    ? src.slice(gateStart, gateEnd)
    : '';

  it('source file contains ZURI_REQUIRE_VERIFIED_PROVIDER env flag check', () => {
    expect(src).toContain('ZURI_REQUIRE_VERIFIED_PROVIDER');
  });

  it('gate is enabled only when env flag equals "true" (defensive default is off)', () => {
    // When the env var is absent or any value other than "true", the
    // comparison === 'true' is false and the gate does not run.
    expect(src).toMatch(/ZURI_REQUIRE_VERIFIED_PROVIDER.*===.*['"]true['"]/);
  });

  it('source file queries provider_payment_methods table', () => {
    expect(src).toContain('provider_payment_methods');
  });

  it('gate checks verification_status !== "verified" before allowing payment', () => {
    expect(gateBlock).toMatch(/verification_status !== ['"]verified['"]/);
  });

  it('gate applies to "paybill" payment type', () => {
    expect(gateBlock).toMatch(/payment_type.*===.*['"]paybill['"]/);
  });

  it('gate applies to "till" payment type', () => {
    expect(gateBlock).toMatch(/payment_type.*===.*['"]till['"]/);
  });

  it('gate does NOT apply to "send" payment type (peer-to-peer is exempt)', () => {
    // The condition must name only paybill/till; 'send' must not appear as
    // an equality target inside the gate block.
    expect(gateBlock).not.toMatch(/payment_type\s*===\s*['"]send['"]/);
  });

  it('returns 422 on unverified provider rejection', () => {
    expect(gateBlock).toContain('422');
  });

  it('returns error key "unverified_provider" on rejection', () => {
    expect(gateBlock).toContain('unverified_provider');
  });

  it('logs evt "unverified_provider_rejected" on rejection', () => {
    expect(gateBlock).toContain('unverified_provider_rejected');
  });

  it('logs evt "provider_gate_lookup_failed" on DB lookup error', () => {
    expect(gateBlock).toContain('provider_gate_lookup_failed');
  });

  it('uses supabaseAdmin (service_role client) for the gate lookup', () => {
    expect(gateBlock).toContain('supabaseAdmin');
  });

  it('gate is placed AFTER auth check and BEFORE risk engine call', () => {
    const authIdx = src.indexOf('getUser(jwt)');
    const gateIdx = src.indexOf('ZURI_REQUIRE_VERIFIED_PROVIDER');
    const riskIdx = src.indexOf('evaluateRisk(');
    expect(authIdx, 'getUser(jwt) must exist in source').toBeGreaterThan(-1);
    expect(gateIdx, 'ZURI_REQUIRE_VERIFIED_PROVIDER must exist in source').toBeGreaterThan(-1);
    expect(riskIdx, 'evaluateRisk( must exist in source').toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(authIdx);
    expect(gateIdx).toBeLessThan(riskIdx);
  });
});
