/**
 * admin-soc-readonly — INTEGRATION tests (hit the DEPLOYED Edge Function).
 *
 * Unlike the unit suite (tests/unit/admin-soc-readonly.test.js), which only
 * reads source text, these tests make real HTTP requests against the deployed
 * `admin-soc-readonly` Edge Function using `fetch()` — exactly as a browser
 * HTTP client would. They are NOT part of `test:ci` / `prepitch`; run them
 * explicitly with `npm run test:integration`.
 *
 * ── Required environment variables ──────────────────────────────────────────
 *   SUPABASE_URL       (or VITE_SUPABASE_URL)       — project URL, https://…
 *   SUPABASE_ANON_KEY  (or VITE_SUPABASE_ANON_KEY)  — public anon key
 *
 * ── Optional per-role JWTs (tests self-skip when a JWT is absent) ────────────
 *   SOC_TEST_ADMIN_JWT          — JWT for a user with app_metadata.role=admin
 *   SOC_TEST_AUDITOR_JWT        — …role=auditor
 *   SOC_TEST_FRAUD_ANALYST_JWT  — …role=fraud_analyst
 *   SOC_TEST_OPERATOR_JWT       — …role=operator
 *   SOC_TEST_NONADMIN_JWT       — JWT for a user with NO admin role (e.g. customer)
 *   SOC_TEST_RATE_LIMIT         — set to "1" to opt in to the heavy 61-request
 *                                 rate-limit test (off by default).
 *
 * NOTE: These tests assume test users with the roles above already exist in the
 * target Supabase project. The first time they run they may fail/skip because
 * those users (and their JWTs) do not exist yet. That is expected — test users
 * will be seeded in Phase 6 or via a one-time setup script. Until then, each
 * role-specific test SKIPS when its JWT env var is not provided.
 */

import { describe, it, expect } from 'vitest';

// ── Env wiring ────────────────────────────────────────────────────────────────

const baseUrl =
  process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const anonKey =
  process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const funcUrl = baseUrl
  ? `${baseUrl.replace(/\/+$/, '')}/functions/v1/admin-soc-readonly`
  : '';

const envReady = Boolean(funcUrl && anonKey && /^https:\/\/.+/.test(baseUrl));

const JWT = {
  admin:         process.env.SOC_TEST_ADMIN_JWT         || '',
  auditor:       process.env.SOC_TEST_AUDITOR_JWT       || '',
  fraud_analyst: process.env.SOC_TEST_FRAUD_ANALYST_JWT || '',
  operator:      process.env.SOC_TEST_OPERATOR_JWT      || '',
  nonadmin:      process.env.SOC_TEST_NONADMIN_JWT      || '',
};

const runRateLimit = process.env.SOC_TEST_RATE_LIMIT === '1';

const ALL_PANEL_KEYS = [
  'panel_1_system_health',
  'panel_2_webhook_health_24h',
  'panel_3_risk_trend_24h',
  'panel_4_payment_flow',
  'panel_5_scam_signals',
  'panel_6_provider_health',
  'panel_7_live_audit',
  'panel_8_manual_review_queue',
  'panel_9_device_trust',
  'panel_10_webhook_failures',
  'panel_11_reconciliation_runs',
  'panel_12_wrong_number_queue',
];

// ── HTTP helper — mirrors a real browser HTTP client ──────────────────────────

async function callSoc({ jwt, body, includeApiKey = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (includeApiKey && anonKey) headers.apikey = anonKey;
  if (jwt) headers.Authorization = `Bearer ${jwt}`;

  const res = await fetch(funcUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json };
}

// ── Live suite (skips entirely when env not configured) ───────────────────────

describe.skipIf(!envReady)('admin-soc-readonly (integration)', () => {
  it('returns 401 with no auth header', { timeout: 45_000 }, async () => {
    // No Authorization header and no apikey — the platform gateway / function
    // must reject an unauthenticated caller.
    const { status } = await callSoc({ includeApiKey: false });
    expect(status).toBe(401);
  });

  it.skipIf(!JWT.nonadmin)(
    'returns 403 with non-admin role',
    { timeout: 45_000 },
    async () => {
      const { status, json } = await callSoc({ jwt: JWT.nonadmin });
      expect(status).toBe(403);
      expect(json?.error).toBe('forbidden');
    },
  );

  it.skipIf(!JWT.admin)(
    'admin role returns all 12 panels',
    { timeout: 45_000 },
    async () => {
      const { status, json } = await callSoc({ jwt: JWT.admin });
      expect(status).toBe(200);
      expect(json?.panels).toBeTruthy();
      for (const key of ALL_PANEL_KEYS) {
        expect(json.panels).toHaveProperty(key);
      }
      // admin sees every panel — none should be role-gated to null.
      expect(json.panels.panel_9_device_trust).not.toBeNull();
    },
  );

  it.skipIf(!JWT.auditor)(
    'auditor role returns all 12 panels',
    { timeout: 45_000 },
    async () => {
      const { status, json } = await callSoc({ jwt: JWT.auditor });
      expect(status).toBe(200);
      for (const key of ALL_PANEL_KEYS) {
        expect(json.panels).toHaveProperty(key);
      }
      // auditor is permitted the PII device-trust panel.
      expect(json.panels.panel_9_device_trust).not.toBeNull();
    },
  );

  it.skipIf(!JWT.fraud_analyst)(
    'fraud_analyst role returns null for panel_9_device_trust',
    { timeout: 45_000 },
    async () => {
      const { status, json } = await callSoc({ jwt: JWT.fraud_analyst });
      expect(status).toBe(200);
      // PII panel — fraud_analyst is explicitly excluded.
      expect(json.panels.panel_9_device_trust).toBeNull();
      // …but a panel it IS permitted (panel 7) should be present/non-null.
      expect(json.panels).toHaveProperty('panel_7_live_audit');
    },
  );

  it.skipIf(!JWT.operator)(
    'operator role returns null for panel_3_risk_trend',
    { timeout: 45_000 },
    async () => {
      const { status, json } = await callSoc({ jwt: JWT.operator });
      expect(status).toBe(200);
      // operator is not permitted the risk-engine trend panel.
      expect(json.panels.panel_3_risk_trend_24h).toBeNull();
      // …but a panel it IS permitted (panel 1) should be present.
      expect(json.panels).toHaveProperty('panel_1_system_health');
    },
  );

  it.skipIf(!JWT.admin)(
    'panels filtered by request body when provided',
    { timeout: 45_000 },
    async () => {
      const { status, json } = await callSoc({
        jwt: JWT.admin,
        body: { panels: ['panel_1_system_health'] },
      });
      expect(status).toBe(200);
      // Requested panel is populated…
      expect(json.panels.panel_1_system_health).not.toBeNull();
      // …and an unrequested panel is filtered out to null.
      expect(json.panels.panel_2_webhook_health_24h).toBeNull();
    },
  );

  it.skipIf(!JWT.admin)(
    'response has generated_at, caller_role, panels keys',
    { timeout: 45_000 },
    async () => {
      const { status, json } = await callSoc({ jwt: JWT.admin });
      expect(status).toBe(200);
      expect(json).toHaveProperty('generated_at');
      expect(json).toHaveProperty('caller_role');
      expect(json).toHaveProperty('panels');
      expect(json.caller_role).toBe('admin');
      expect(typeof json.generated_at).toBe('string');
    },
  );

  it.skipIf(!JWT.admin || !runRateLimit)(
    'rate limit kicks in after 60 requests in 1 minute',
    { timeout: 120_000 },
    async () => {
      // Heavy test — opt in with SOC_TEST_RATE_LIMIT=1. Fires 61 sequential
      // requests; the 60 req/min limiter must return at least one 429.
      let saw429 = false;
      for (let i = 0; i < 61; i++) {
        const { status } = await callSoc({ jwt: JWT.admin });
        if (status === 429) {
          saw429 = true;
          break;
        }
      }
      expect(saw429).toBe(true);
    },
  );

  it.skipIf(!JWT.admin)(
    'Cache-Control header set to max-age=15',
    { timeout: 45_000 },
    async () => {
      const { status, headers } = await callSoc({ jwt: JWT.admin });
      expect(status).toBe(200);
      expect(headers.get('cache-control') ?? '').toMatch(/max-age=15/);
    },
  );
});

// ── Env contract (always runs, even when the live suite is skipped) ───────────

describe('admin-soc-readonly (integration) — env contract', () => {
  it('documents required variables when live tests are skipped', () => {
    if (envReady) {
      expect(funcUrl).toMatch(/\/functions\/v1\/admin-soc-readonly$/);
    } else {
      // Not configured — the live suite above is skipped by design.
      expect(envReady).toBe(false);
    }
  });
});
