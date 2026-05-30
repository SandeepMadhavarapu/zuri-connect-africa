/**
 * SecurityOperationsCenter structural tests.
 *
 * The component cannot be imported in Vitest/Node (JSX + @/ aliases + browser
 * Supabase client).  All assertions read source text and verify structural
 * properties.  These tests fail immediately if a shadow import is
 * re-introduced or if a required panel key / behaviour is removed.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync }         from 'node:fs';
import { resolve }              from 'node:path';

const src = readFileSync(
  resolve(process.cwd(), 'src/pages/admin/SecurityOperationsCenter.jsx'),
  'utf8',
);

// ── Shadow import removal ─────────────────────────────────────────────────────

describe('SecurityOperationsCenter: shadow import removal', () => {
  it('does NOT import from @/backend/', () => {
    expect(src).not.toMatch(/@\/backend\//);
  });

  it('does NOT import from @/server/', () => {
    expect(src).not.toMatch(/@\/server\//);
  });

  it('does NOT import from @/lib/auditLogger', () => {
    expect(src).not.toMatch(/auditLogger/);
  });

  it('does NOT import from @/lib/queue', () => {
    expect(src).not.toMatch(/@\/lib\/queue/);
  });

  it('does NOT import from @/lib/observability', () => {
    expect(src).not.toMatch(/@\/lib\/observability/);
  });

  it('does NOT import from @/lib/settlementEngine', () => {
    expect(src).not.toMatch(/settlementEngine/);
  });

  it('does NOT import framer-motion', () => {
    expect(src).not.toMatch(/framer-motion/);
  });
});

// ── Service layer wiring ──────────────────────────────────────────────────────

describe('SecurityOperationsCenter: service wiring', () => {
  it('imports fetchAdminSocSnapshot', () => {
    expect(src).toMatch(/fetchAdminSocSnapshot/);
  });

  it('imports from @/services/adminSocService', () => {
    expect(src).toMatch(/@\/services\/adminSocService/);
  });

  it('does NOT create a duplicate service (no functions.invoke in component)', () => {
    expect(src).not.toMatch(/functions\.invoke/);
  });
});

// ── Panel key references ──────────────────────────────────────────────────────

describe('SecurityOperationsCenter: panel key references (7–12)', () => {
  it('references panel_7_live_audit', () => {
    expect(src).toMatch(/panel_7_live_audit/);
  });

  it('references panel_8_manual_review_queue', () => {
    expect(src).toMatch(/panel_8_manual_review_queue/);
  });

  it('references panel_9_device_trust', () => {
    expect(src).toMatch(/panel_9_device_trust/);
  });

  it('references panel_10_webhook_failures', () => {
    expect(src).toMatch(/panel_10_webhook_failures/);
  });

  it('references panel_11_reconciliation_runs', () => {
    expect(src).toMatch(/panel_11_reconciliation_runs/);
  });

  it('references panel_12_wrong_number_queue', () => {
    expect(src).toMatch(/panel_12_wrong_number_queue/);
  });
});

// ── Polling and lifecycle ─────────────────────────────────────────────────────

describe('SecurityOperationsCenter: 30-second refresh interval', () => {
  it('calls setInterval for polling', () => {
    expect(src).toMatch(/setInterval/);
  });

  it('uses 30_000 ms (30-second) interval', () => {
    expect(src).toMatch(/30_000|30000/);
  });

  it('cleans up interval on unmount via clearInterval', () => {
    expect(src).toMatch(/clearInterval/);
  });

  it('uses useEffect to mount the interval', () => {
    expect(src).toMatch(/useEffect/);
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('SecurityOperationsCenter: error state', () => {
  it('tracks an error state variable', () => {
    expect(src).toMatch(/setError/);
  });

  it('renders an error banner when error is set', () => {
    expect(src).toMatch(/\{error &&/);
  });

  it('exposes a Retry action in the error banner', () => {
    expect(src).toMatch(/Retry/);
  });

  it('maps result.error from fetchAdminSocSnapshot to state', () => {
    expect(src).toMatch(/result\.error/);
  });
});

// ── Restricted panel (panel_9) ────────────────────────────────────────────────

describe('SecurityOperationsCenter: panel_9 locked card when null', () => {
  it('renders "Restricted" text for null panels', () => {
    expect(src).toMatch(/Restricted/);
  });

  it('checks data === null to identify restricted panels', () => {
    expect(src).toMatch(/data === null/);
  });

  it('shows a Lock icon for restricted panels', () => {
    expect(src).toMatch(/Lock/);
  });
});

// ── Empty state strings ───────────────────────────────────────────────────────

describe('SecurityOperationsCenter: empty state strings', () => {
  it('panel_7 — empty state: no audit events', () => {
    expect(src).toMatch(/No audit events in the last hour/);
  });

  it('panel_8 — empty state: review queue empty', () => {
    expect(src).toMatch(/Review queue empty/);
  });

  it('panel_9 — empty state: no recent device events', () => {
    expect(src).toMatch(/No recent device events/);
  });

  it('panel_10 — empty state: no webhook failures', () => {
    expect(src).toMatch(/No webhook failures in the last 24h/);
  });

  it('panel_11 runs — empty state: no reconciliation runs', () => {
    expect(src).toMatch(/No reconciliation runs recorded/);
  });

  it('panel_11 trend — empty state: insufficient data', () => {
    expect(src).toMatch(/Insufficient data/);
  });

  it('panel_12 — empty state: no wrong-number reports', () => {
    expect(src).toMatch(/No open wrong-number reports/);
  });
});

// ── Panel titles present ──────────────────────────────────────────────────────

describe('SecurityOperationsCenter: panel titles', () => {
  it('renders LIVE AUDIT STREAM title', () => {
    expect(src).toMatch(/LIVE AUDIT STREAM/);
  });

  it('renders MANUAL REVIEW QUEUE title', () => {
    expect(src).toMatch(/MANUAL REVIEW QUEUE/);
  });

  it('renders DEVICE TRUST REGISTRY title', () => {
    expect(src).toMatch(/DEVICE TRUST REGISTRY/);
  });

  it('renders WEBHOOK FAILURES title', () => {
    expect(src).toMatch(/WEBHOOK FAILURES/);
  });

  it('renders RECONCILIATION RUNS title', () => {
    expect(src).toMatch(/RECONCILIATION RUNS/);
  });

  it('renders WRONG NUMBER QUEUE title', () => {
    expect(src).toMatch(/WRONG NUMBER QUEUE/);
  });
});
