/**
 * AdminSecurityDashboard + adminSocService structural tests.
 *
 * Both files cannot be imported in Vitest/Node (JSX + @/ aliases + browser
 * Supabase client). All assertions read source text and verify structural
 * properties. These tests fail immediately if a shadow import is re-introduced
 * or if a required panel key / behaviour is removed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve }     from 'node:path';

const pageSrc = readFileSync(
  resolve(process.cwd(), 'src/pages/AdminSecurityDashboard.jsx'),
  'utf8',
);

const svcSrc = readFileSync(
  resolve(process.cwd(), 'src/services/adminSocService.js'),
  'utf8',
);

// ── Page — import hygiene ─────────────────────────────────────────────────────

describe('AdminSecurityDashboard: shadow import removal', () => {
  it('does NOT import from @/backend/', () => {
    expect(pageSrc).not.toMatch(/@\/backend\//);
  });

  it('does NOT import from @/server/', () => {
    expect(pageSrc).not.toMatch(/@\/server\//);
  });

  it('does NOT import from @/lib/auditLogger', () => {
    expect(pageSrc).not.toMatch(/auditLogger/);
  });

  it('does NOT import from @/lib/settlementEngine', () => {
    expect(pageSrc).not.toMatch(/settlementEngine/);
  });

  it('does NOT import from @/lib/queue', () => {
    expect(pageSrc).not.toMatch(/@\/lib\/queue/);
  });

  it('does NOT import from @/lib/observability', () => {
    expect(pageSrc).not.toMatch(/@\/lib\/observability/);
  });

  it('does NOT import retryFailed from @/api/settlement', () => {
    expect(pageSrc).not.toMatch(/retryFailed/);
  });
});

// ── Page — service layer wiring ───────────────────────────────────────────────

describe('AdminSecurityDashboard: service layer wiring', () => {
  it('imports fetchAdminSocSnapshot', () => {
    expect(pageSrc).toMatch(/fetchAdminSocSnapshot/);
  });

  it('imports from @/services/adminSocService', () => {
    expect(pageSrc).toMatch(/@\/services\/adminSocService/);
  });
});

// ── Page — all 6 strategic panel keys referenced ──────────────────────────────

describe('AdminSecurityDashboard: panel key references', () => {
  it('references panel_1_system_health', () => {
    expect(pageSrc).toMatch(/panel_1_system_health/);
  });

  it('references panel_2_webhook_health_24h', () => {
    expect(pageSrc).toMatch(/panel_2_webhook_health_24h/);
  });

  it('references panel_3_risk_trend_24h', () => {
    expect(pageSrc).toMatch(/panel_3_risk_trend_24h/);
  });

  it('references panel_4_payment_flow', () => {
    expect(pageSrc).toMatch(/panel_4_payment_flow/);
  });

  it('references panel_5_scam_signals', () => {
    expect(pageSrc).toMatch(/panel_5_scam_signals/);
  });

  it('references panel_6_provider_health', () => {
    expect(pageSrc).toMatch(/panel_6_provider_health/);
  });
});

// ── Page — polling and lifecycle ──────────────────────────────────────────────

describe('AdminSecurityDashboard: 30-second refresh interval', () => {
  it('calls setInterval for polling', () => {
    expect(pageSrc).toMatch(/setInterval/);
  });

  it('uses 30_000 ms (30-second) interval', () => {
    expect(pageSrc).toMatch(/30_000|30000/);
  });

  it('cleans up interval on unmount via clearInterval', () => {
    expect(pageSrc).toMatch(/clearInterval/);
  });

  it('uses useEffect for mounting the interval', () => {
    expect(pageSrc).toMatch(/useEffect/);
  });
});

// ── Page — error state handling ───────────────────────────────────────────────

describe('AdminSecurityDashboard: error state', () => {
  it('tracks an error state variable', () => {
    expect(pageSrc).toMatch(/setError/);
  });

  it('renders an error banner when error is set', () => {
    expect(pageSrc).toMatch(/\{error &&/);
  });

  it('exposes a Retry action in the error banner', () => {
    expect(pageSrc).toMatch(/Retry/);
  });

  it('maps result.error from fetchAdminSocSnapshot to state', () => {
    expect(pageSrc).toMatch(/result\.error/);
  });
});

// ── Page — null panel (Restricted) placeholder ────────────────────────────────

describe('AdminSecurityDashboard: restricted panel rendering', () => {
  it('renders "Restricted" text for null panels', () => {
    expect(pageSrc).toMatch(/Restricted/);
  });

  it('checks data === null to identify restricted panels', () => {
    expect(pageSrc).toMatch(/data === null/);
  });

  it('shows a Lock icon for restricted panels', () => {
    expect(pageSrc).toMatch(/Lock/);
  });
});

// ── Service — adminSocService structural assertions ───────────────────────────

describe('adminSocService: structure', () => {
  it('exports fetchAdminSocSnapshot as a named export', () => {
    expect(svcSrc).toMatch(/export\s+async\s+function\s+fetchAdminSocSnapshot/);
  });

  it('uses getSupabaseBrowserClient', () => {
    expect(svcSrc).toMatch(/getSupabaseBrowserClient/);
  });

  it('invokes admin-soc-readonly Edge Function', () => {
    expect(svcSrc).toMatch(/admin-soc-readonly/);
  });

  it('never throws — maps error to structured return value', () => {
    expect(svcSrc).toMatch(/catch/);
    expect(svcSrc).toMatch(/\{\s*error:/);
  });

  it('maps 403 to forbidden error code', () => {
    expect(svcSrc).toMatch(/403/);
    expect(svcSrc).toMatch(/forbidden/);
  });

  it('maps 401 to auth_failed error code', () => {
    expect(svcSrc).toMatch(/401/);
    expect(svcSrc).toMatch(/auth_failed/);
  });

  it('maps 429 to rate_limited error code', () => {
    expect(svcSrc).toMatch(/429/);
    expect(svcSrc).toMatch(/rate_limited/);
  });

  it('has a 30-second client-side cache', () => {
    expect(svcSrc).toMatch(/30_000|30000/);
    expect(svcSrc).toMatch(/expires_at/);
  });

  it('uses a Map for the cache', () => {
    expect(svcSrc).toMatch(/new Map/);
  });

  it('uses JSON.stringify for the cache key', () => {
    expect(svcSrc).toMatch(/JSON\.stringify/);
  });
});
