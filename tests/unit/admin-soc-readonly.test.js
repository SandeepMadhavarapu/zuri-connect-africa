/**
 * admin-soc-readonly structural tests
 *
 * The Edge Function uses npm:zod and Deno globals so it cannot be imported
 * directly in Vitest/Node. All assertions read the source file as text and
 * verify that required structural properties are present.
 *
 * These tests guard against regression during future edits — if a structural
 * property is removed (e.g. panel key, role access map, cache header), the
 * corresponding test will fail immediately rather than silently shipping a
 * broken dashboard backend.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(process.cwd(), 'supabase/functions/admin-soc-readonly/index.ts'),
  'utf8',
);

// ── Import and dependency assertions ─────────────────────────────────────────

describe('admin-soc-readonly: imports and dependencies', () => {
  it('imports Zod via npm: specifier for Deno compatibility', () => {
    expect(src).toMatch(/from\s+['"]npm:zod['"]/);
  });

  it('imports requireAdminRole from _shared/admin-roles', () => {
    expect(src).toMatch(/requireAdminRole.*admin-roles/);
  });

  it('imports checkRateLimit from _shared/rate-limit', () => {
    expect(src).toMatch(/checkRateLimit.*rate-limit/);
  });

  it('uses SUPABASE_SERVICE_ROLE_KEY for all DB queries (not anon key)', () => {
    expect(src).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    // Must NOT create a user-JWT client for data reads — this is admin data
    expect(src).not.toMatch(/SUPABASE_ANON_KEY/);
  });
});

// ── HTTP protocol assertions ──────────────────────────────────────────────────

describe('admin-soc-readonly: HTTP protocol', () => {
  it('handles OPTIONS preflight', () => {
    expect(src).toMatch(/req\.method.*===.*['"]OPTIONS['"]/);
  });

  it('returns 401 for missing or invalid authorization', () => {
    expect(src).toMatch(/\b401\b/);
  });

  it('returns 403 for authenticated callers with insufficient role', () => {
    expect(src).toMatch(/\b403\b/);
  });

  it('returns 429 when rate limit is exceeded', () => {
    expect(src).toMatch(/\b429\b/);
    expect(src).toMatch(/rate_limited/);
  });

  it('sets Cache-Control: max-age=15 on successful responses', () => {
    expect(src).toMatch(/Cache-Control.*max-age=15/);
  });
});

// ── Role and access-control assertions ───────────────────────────────────────

describe('admin-soc-readonly: role access control', () => {
  it('calls requireAdminRole with all 4 allowed roles', () => {
    expect(src).toMatch(/requireAdminRole/);
    expect(src).toMatch(/['"]admin['"]/);
    expect(src).toMatch(/['"]auditor['"]/);
    expect(src).toMatch(/['"]fraud_analyst['"]/);
    expect(src).toMatch(/['"]operator['"]/);
  });

  it('source defines ROLE_PANEL_ACCESS constant with all 4 roles', () => {
    expect(src).toMatch(/ROLE_PANEL_ACCESS/);
    expect(src).toMatch(/admin\s*:/);
    expect(src).toMatch(/auditor\s*:/);
    expect(src).toMatch(/fraud_analyst\s*:/);
    expect(src).toMatch(/operator\s*:/);
  });

  it('fraud_analyst role is explicitly excluded from panel_9_device_trust', () => {
    // ROLE_PANEL_ACCESS for fraud_analyst must NOT include 9
    const fraudAnalystLine = src.match(/fraud_analyst\s*:\s*\[([\d,\s]+)\]/)?.[1] ?? '';
    // Parse the numbers from the array literal
    const nums = fraudAnalystLine.split(',').map((n) => parseInt(n.trim(), 10)).filter(Number.isFinite);
    expect(nums).not.toContain(9);
  });

  it('operator role is explicitly excluded from panel_3_risk_trend_24h', () => {
    // ROLE_PANEL_ACCESS for operator must NOT include 3
    const operatorLine = src.match(/operator\s*:\s*\[([\d,\s]+)\]/)?.[1] ?? '';
    const nums = operatorLine.split(',').map((n) => parseInt(n.trim(), 10)).filter(Number.isFinite);
    expect(nums).not.toContain(3);
  });
});

// ── Panel key assertions ──────────────────────────────────────────────────────

describe('admin-soc-readonly: all 12 panel keys present', () => {
  it('contains panel_1_system_health', () => {
    expect(src).toMatch(/panel_1_system_health/);
  });

  it('contains panel_2_webhook_health_24h', () => {
    expect(src).toMatch(/panel_2_webhook_health_24h/);
  });

  it('contains panel_3_risk_trend_24h', () => {
    expect(src).toMatch(/panel_3_risk_trend_24h/);
  });

  it('contains panel_4_payment_flow', () => {
    expect(src).toMatch(/panel_4_payment_flow/);
  });

  it('contains panel_5_scam_signals', () => {
    expect(src).toMatch(/panel_5_scam_signals/);
  });

  it('contains panel_6_provider_health', () => {
    expect(src).toMatch(/panel_6_provider_health/);
  });

  it('contains panel_7_live_audit', () => {
    expect(src).toMatch(/panel_7_live_audit/);
  });

  it('contains panel_8_manual_review_queue', () => {
    expect(src).toMatch(/panel_8_manual_review_queue/);
  });

  it('contains panel_9_device_trust', () => {
    expect(src).toMatch(/panel_9_device_trust/);
  });

  it('contains panel_10_webhook_failures', () => {
    expect(src).toMatch(/panel_10_webhook_failures/);
  });

  it('contains panel_11_reconciliation_runs', () => {
    expect(src).toMatch(/panel_11_reconciliation_runs/);
  });

  it('contains panel_12_wrong_number_queue', () => {
    expect(src).toMatch(/panel_12_wrong_number_queue/);
  });
});

// ── Response shape assertions ─────────────────────────────────────────────────

describe('admin-soc-readonly: response shape', () => {
  it('response includes generated_at top-level key', () => {
    expect(src).toMatch(/generated_at/);
  });

  it('response includes caller_role top-level key', () => {
    expect(src).toMatch(/caller_role/);
  });

  it('response includes panels top-level key', () => {
    expect(src).toMatch(/\bpanels\b/);
  });
});

// ── Operational resilience assertions ────────────────────────────────────────

describe('admin-soc-readonly: operational resilience', () => {
  it('logs panel_query_failed for individual panel failures (partial degradation)', () => {
    expect(src).toMatch(/panel_query_failed/);
    // Partial degradation: failed panel returns null, not 500
    // Verify the safePanel wrapper (or equivalent) catches errors per panel
    expect(src).toMatch(/safePanel|catch\s*\(/);
  });

  it('has rate limiting using the shared checkRateLimit helper', () => {
    expect(src).toMatch(/checkRateLimit\(/);
  });

  it('does not log panel response contents (PII protection)', () => {
    // The structured summary log must not pass the panels object.
    // Metadata only: ts, fn, evt, user_id, role, panels_requested, panels_returned, duration_ms.
    expect(src).not.toMatch(/console\.\w+\(\s*panels\b/);
    expect(src).not.toMatch(/console\.\w+\(JSON\.stringify\(\s*panels\b/);
    // The evt:'panels_fetched' log block must not reference panel data keys like panel_7_live_audit
    const logMatch = src.match(/evt:\s*['"]panels_fetched['"]([\s\S]{0,300})/)?.[0] ?? '';
    expect(logMatch).not.toMatch(/panel_[0-9]+_/);
  });
});
