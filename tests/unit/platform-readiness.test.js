/**
 * Zuri Connect Africa — Platform Readiness & Provider Directory regressions.
 *
 * Locks in the Safaricom-pitch honesty rules so future edits cannot:
 *   1. Mark a platform component as production-ready
 *   2. Ship a provider directory entry that claims a PayBill / Till number
 *      without the verification metadata that the pitch promised
 *   3. Re-introduce overclaim phrases ("PCI-DSS L1", "KYC Tier 3",
 *      "NID Verified", "production-ready", generic "Live" ecosystem badges)
 *   4. Drop the Budget sample disclaimer or the Home directory banner
 *   5. Restore an un-gated "Dev only: default PIN" hint
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, relative } from 'node:path';

import {
  PLATFORM_COMPONENTS,
  READINESS_STATUS,
  READINESS_STATUS_META,
  OPERATIONAL_PREVIEWS,
  findOverclaimingComponents,
} from '@/lib/platformReadiness.js';
import {
  PROVIDER_DIRECTORY_SEED,
  PROVIDER_DIRECTORY_CATEGORIES,
  findUnverifiedNumberClaims,
  isVerifiedProductionEntry,
  getDirectoryDisplayCode,
  PENDING_VERIFICATION_PLACEHOLDER,
  PENDING_VERIFICATION_RENDER_LABEL,
} from '@/lib/providerDirectory.js';

const ROOT = process.cwd();

function read(file) {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walkUi(dir, exts = ['.jsx', '.tsx', '.js', '.ts'], out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkUi(full, exts, out);
    else if (exts.includes(extname(name))) out.push(full);
  }
  return out;
}

const UI_FILES = [
  ...walkUi(resolve(ROOT, 'src/pages')),
  ...walkUi(resolve(ROOT, 'src/components')),
];

// ── 1. Platform readiness honesty ────────────────────────────────────────────

describe('platform readiness · architecture matrix', () => {
  const REQUIRED_COMPONENT_IDS = [
    'client_app',
    'supabase_auth',
    'edge_functions',
    'daraja_stk_lifecycle',
    'webhook_handler',
    'risk_engine',
    'step_up_verification',
    'ledger_rpc',
    'hash_chain_ledger',
    'reconciliation_job',
    'admin_review',
    'duke_ai_router',
    'notification_dispatcher',
    'provider_directory_registry',
    'offline_step_up_queue',
  ];

  it('exposes every required architecture component', () => {
    const ids = PLATFORM_COMPONENTS.map((c) => c.id);
    for (const id of REQUIRED_COMPONENT_IDS) {
      expect(ids, `missing required component: ${id}`).toContain(id);
    }
  });

  it('uses only the four honest statuses', () => {
    const allowed = new Set(Object.values(READINESS_STATUS));
    expect(allowed.has('production_ready'), 'production_ready must NEVER be an allowed status').toBe(false);
    for (const c of PLATFORM_COMPONENTS) {
      expect(allowed.has(c.status), `${c.id} has unknown status "${c.status}"`).toBe(true);
    }
    expect(findOverclaimingComponents()).toEqual([]);
  });

  it('every implemented component points at proof in the repo', () => {
    for (const c of PLATFORM_COMPONENTS) {
      if (c.status !== READINESS_STATUS.IMPLEMENTED) continue;
      expect(Array.isArray(c.proof), `${c.id} must have a proof array`).toBe(true);
      expect(c.proof.length, `${c.id} must list at least one proof path`).toBeGreaterThan(0);
    }
  });

  it('status meta pills exist for every status', () => {
    for (const status of Object.values(READINESS_STATUS)) {
      expect(READINESS_STATUS_META[status], `meta missing for ${status}`).toBeDefined();
      expect(READINESS_STATUS_META[status].label).toBeTruthy();
    }
  });

  it('operational previews exist for provider verification, dispute/reversal and merchant readiness', () => {
    const ids = OPERATIONAL_PREVIEWS.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['provider_verification', 'dispute_reversal', 'merchant_business']));
    for (const p of OPERATIONAL_PREVIEWS) {
      expect(p.label).toMatch(/preview|readiness/i);
      expect(p.bullets.length).toBeGreaterThan(0);
    }
  });
});

// ── 2. Provider directory registry honesty ───────────────────────────────────

describe('provider directory · verification metadata', () => {
  it('covers every required directory category', () => {
    const categories = new Set(PROVIDER_DIRECTORY_SEED.map((e) => e.category));
    for (const required of PROVIDER_DIRECTORY_CATEGORIES) {
      expect(categories.has(required), `missing category ${required}`).toBe(true);
    }
  });

  it('never ships a PayBill / Till number in the seed', () => {
    for (const e of PROVIDER_DIRECTORY_SEED) {
      expect(e.paybill, `${e.providerName} must not ship a paybill in this build`).toBeNull();
      expect(e.till, `${e.providerName} must not ship a till in this build`).toBeNull();
    }
  });

  it('every entry carries the required verification metadata', () => {
    for (const e of PROVIDER_DIRECTORY_SEED) {
      expect(e.verificationStatus).toBe('unverified_sample');
      expect(e.sourceRequired).toBe(true);
      expect(e.lastVerifiedAt).toBeNull();
      expect(e.productionStatus).toBe('requires_provider_source');
      expect(e.reportWrongNumberEnabled).toBe(true);
      expect(e.displayCode).toBe(PENDING_VERIFICATION_PLACEHOLDER);
    }
    expect(findUnverifiedNumberClaims()).toEqual([]);
  });

  it('isVerifiedProductionEntry returns false for every seed entry and true only for fully-verified shapes', () => {
    for (const e of PROVIDER_DIRECTORY_SEED) {
      expect(isVerifiedProductionEntry(e)).toBe(false);
    }
    // A fully verified entry shape must satisfy all four conditions
    const verified = {
      verificationStatus: 'verified',
      sourceRequired: false,
      lastVerifiedAt: '2026-05-24T12:00:00Z',
      productionStatus: 'staging_ready',
      paybill: '999999',
    };
    expect(isVerifiedProductionEntry(verified)).toBe(true);
    // Any single missing precondition flips it back to false
    expect(isVerifiedProductionEntry({ ...verified, verificationStatus: 'pending_review' })).toBe(false);
    expect(isVerifiedProductionEntry({ ...verified, sourceRequired: true })).toBe(false);
    expect(isVerifiedProductionEntry({ ...verified, lastVerifiedAt: null })).toBe(false);
    expect(isVerifiedProductionEntry({ ...verified, productionStatus: 'requires_provider_source' })).toBe(false);
  });

  it('getDirectoryDisplayCode hides numeric values for unverified entries and reveals them only when verified', () => {
    for (const e of PROVIDER_DIRECTORY_SEED) {
      expect(getDirectoryDisplayCode(e)).toBe(PENDING_VERIFICATION_RENDER_LABEL);
    }
    const verified = {
      verificationStatus: 'verified',
      sourceRequired: false,
      lastVerifiedAt: '2026-05-24T12:00:00Z',
      productionStatus: 'staging_ready',
      paybill: '888777',
    };
    expect(getDirectoryDisplayCode(verified)).toBe('888777');
    // Even if a `shortcode` is attached to an unverified entry, the helper must
    // refuse to render it.
    expect(getDirectoryDisplayCode({
      ...verified,
      verificationStatus: 'unverified_sample',
      sourceRequired: true,
      lastVerifiedAt: null,
      productionStatus: 'requires_provider_source',
      shortcode: '888880',
    })).toBe(PENDING_VERIFICATION_RENDER_LABEL);
  });
});

// ── 4. Forbidden overclaim phrases in user-visible UI ────────────────────────

describe('pitch honesty · forbidden overclaim phrases', () => {
  const FORBIDDEN_SUBSTRINGS = [
    'PCI-DSS L1',
    'PCI DSS L1',
    'KYC Tier 3',
    'NID Verified',
    'production-ready',
    'Production-ready',
    'Production Ready',
  ];

  it('no user-visible UI file contains a forbidden overclaim phrase', () => {
    const offenders = [];
    for (const file of UI_FILES) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      const text = stripJsComments(readFileSync(file, 'utf8'));
      for (const needle of FORBIDDEN_SUBSTRINGS) {
        if (text.includes(needle)) offenders.push(`${rel} :: "${needle}"`);
      }
    }
    expect(offenders, `Forbidden overclaim strings: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no ecosystem service is shipped with a generic "Live" status badge', () => {
    const eco = stripJsComments(read('src/lib/ecosystemServices.js'));
    // The status badge keys are a closed enum — assert no entry uses 'Live'
    // (or 'live') as its status value.
    expect(eco).not.toMatch(/status:\s*['"]Live['"]/);
    expect(eco).not.toMatch(/status:\s*['"]live['"]/);
  });

  it('any "Dev only: default PIN" hint must sit behind allowDefaultDemoPin', () => {
    for (const file of UI_FILES) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      const text = stripJsComments(readFileSync(file, 'utf8'));
      const idx = text.indexOf('Dev only: default PIN');
      if (idx === -1) continue;
      const window = text.slice(Math.max(0, idx - 600), idx);
      expect(window, `${rel} has an un-gated "Dev only: default PIN" hint`).toMatch(/allowDefaultDemoPin/);
    }
  });
});

// ── 5. Existing honest disclaimers must remain present ───────────────────────

describe('pitch honesty · disclaimers remain wired', () => {
  // The "Explore Services" PayBill directory (EcosystemGrid) and its
  // "Service directory preview — verified provider source" banner were removed
  // from the Home surface together. That disclaimer only ever existed to keep the
  // grid honest while it was rendered, so with the grid gone the banner is
  // correctly absent — re-asserting its presence would force back dead/dishonest
  // copy. This regression instead guarantees the grid cannot silently return to
  // Home without its honesty banner: Home must surface neither.
  it('Home.jsx ships neither the PayBill directory grid nor a dangling preview banner', () => {
    const text = stripJsComments(read('src/pages/Home.jsx'));
    expect(text, 'EcosystemGrid (PayBill directory) must not be rendered on the Home surface')
      .not.toMatch(/<EcosystemGrid\b/);
    expect(text, 'a "Service directory preview" banner must not linger on Home without the grid it disclaims')
      .not.toMatch(/Service directory preview/i);
  });
});

// ── 6. /platform route is wired and framed honestly ──────────────────────────

describe('platform route · honest framing', () => {
  it('route exists in routeGuard and App', () => {
    const guard = read('src/lib/routeGuard.js');
    const app   = read('src/App.jsx');
    expect(guard).toMatch(/'\/platform'\s*:\s*\{\s*level:\s*'auth'\s*\}/);
    expect(app).toMatch(/<Route\s+path="\/platform"\s+element=\{<PlatformReadiness\s*\/>\}\s*\/>/);
  });

  it('PlatformReadiness page is framed as readiness/preview, not consumer feature', () => {
    const text = stripJsComments(read('src/pages/PlatformReadiness.jsx'));
    expect(text).toMatch(/Platform Readiness/);
    expect(text).toMatch(/Architecture and rollout readiness/i);
    expect(text).toMatch(/Operational workflow preview/i);
    expect(text).not.toMatch(/\bproduction-ready\b/);
    expect(text).not.toMatch(/Production-ready/);
  });
});
