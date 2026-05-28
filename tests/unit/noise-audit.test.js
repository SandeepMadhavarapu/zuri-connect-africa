/**
 * Zuri Connect Africa — UI noise audit
 *
 * Locks in the production-grade label cleanup so a future change does not
 * re-introduce demo-y / overclaiming / decorative tags that make the app feel
 * unfinished. The checks are deliberately STATIC source scans (no rendering,
 * no Supabase) so they remain dependency-free and run in milliseconds.
 *
 * Honesty rule retained: features that are still local-only MUST keep their
 * preview disclaimer. These tests therefore both forbid noisy tags AND assert
 * that the necessary preview banners are still present.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, extname, relative } from 'node:path';

const ROOT = process.cwd();

function read(file) {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir, exts = ['.jsx', '.tsx', '.js', '.ts']) {
  const out = [];
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
    if (st.isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(extname(name))) out.push(full);
  }
  return out;
}

const PAGE_DIR      = resolve(ROOT, 'src/pages');
const COMPONENT_DIR = resolve(ROOT, 'src/components');
const PAGE_FILES    = walk(PAGE_DIR);
const COMPONENT_FILES = walk(COMPONENT_DIR);
const ALL_UI_FILES  = [...PAGE_FILES, ...COMPONENT_FILES];

/**
 * Extract user-visible string fragments from a stripped JSX file:
 *   * `>text<` slot content (skipping `</`, JSX expressions, and empty slots)
 *   * `"…"` and `'…'` literals that look like sentences (>= 3 chars, contain a space or capital)
 * This is intentionally fuzzy — false positives are tolerable because the
 * banned-words list is short and curated.
 */
function userVisibleText(src) {
  const out = [];
  const slotRe = />([^<>{}\n]{2,})</g;
  let m;
  while ((m = slotRe.exec(src))) {
    const t = m[1].trim();
    if (!t) continue;
    out.push(t);
  }
  const litRe = /(["'`])([^"'`\n]{3,})\1/g;
  while ((m = litRe.exec(src))) {
    out.push(m[2]);
  }
  return out;
}

// ── 1. No raw user-facing "fake" / "mock" / capital-D "Demo " text ───────────

describe('noise audit · no raw fake/mock/Demo user-facing labels', () => {
  // Files that are allowed to mention `fake` or `mock` for legitimate reasons.
  // input-otp.jsx uses `hasFakeCaret` as a render prop name (radix-ui surface).
  const FAKE_ALLOWLIST = [/components\/ui\/input-otp\.jsx$/];

  it('no JSX slot/literal contains the word "fake" or "mock" (other than allowlisted util files)', () => {
    const offenders = [];
    for (const file of ALL_UI_FILES) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      if (FAKE_ALLOWLIST.some((p) => p.test(rel))) continue;
      const text = stripComments(read(file));
      const fragments = userVisibleText(text);
      for (const f of fragments) {
        if (/\bfake\b/i.test(f)) offenders.push(`${rel} :: "${f}"`);
        if (/\bmock\b/i.test(f)) offenders.push(`${rel} :: "${f}"`);
      }
    }
    expect(offenders, `Forbidden raw fake/mock labels: ${offenders.join(', ')}`).toEqual([]);
  });

  // "Demo " (capitalised, followed by a Word boundary) is a UX label like
  // "Demo Wallet Ready" / "Demo Mode" that we cleaned up. Variable names like
  // `getDemoTransactionsForUi` are intentionally allowed because they live in
  // identifiers, not visible strings — the slot/literal scan covers visible
  // text only.
  it('no JSX slot/literal starts with "Demo " (cleaned-up wording)', () => {
    const offenders = [];
    for (const file of ALL_UI_FILES) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      const text = stripComments(read(file));
      const fragments = userVisibleText(text);
      for (const f of fragments) {
        // "demo wallet" / "demo mode" / "Demo Wallet" / "demo session" etc.
        // Exclusively block visible labels — identifier-ish strings (no space
        // or no leading capital) are tolerated.
        if (/^Demo\s+[A-Z]/.test(f)) offenders.push(`${rel} :: "${f}"`);
        if (/\bdemo wallet\b/i.test(f)) offenders.push(`${rel} :: "${f}"`);
      }
    }
    expect(offenders, `Forbidden Demo-style labels: ${offenders.join(', ')}`).toEqual([]);
  });
});

// ── 2. Bundles "AI Recommended" is gone (was not data-driven) ────────────────

describe('noise audit · Bundles', () => {
  it('Bundles.jsx no longer hardcodes an "AI Recommended" tag', () => {
    const text = read('src/pages/Bundles.jsx');
    expect(text).not.toMatch(/['"]AI Recommended['"]/);
  });

  it('Bundles.jsx still permits curated curatorial tags ("Popular", "Best Value")', () => {
    const text = read('src/pages/Bundles.jsx');
    expect(text).toMatch(/['"]Popular['"]/);
    expect(text).toMatch(/['"]Best Value['"]/);
  });
});

// ── 3. Home trust chips do not overclaim live network/provider status ────────

describe('noise audit · Home trust chips', () => {
  it('Home.jsx does not show the "Network healthy" overclaim', () => {
    const text = stripComments(read('src/pages/Home.jsx'));
    expect(text).not.toMatch(/['"]Network healthy['"]/i);
  });

  it('Home.jsx keeps Risk + Ledger + Network status chips but without live-time wording', () => {
    const text = stripComments(read('src/pages/Home.jsx'));
    expect(text).toMatch(/Risk monitoring/i);
    expect(text).toMatch(/Ledger integrity/i);
    expect(text).toMatch(/Network status/i);
  });
});

// ── 4. NetworkStatus is a snapshot, not a live probe ─────────────────────────

describe('noise audit · NetworkStatus page', () => {
  it('NetworkStatus.jsx clearly labels itself as a snapshot, not live', () => {
    const text = stripComments(read('src/pages/NetworkStatus.jsx'));
    expect(text).toMatch(/snapshot/i);
    // No "live"/"real-time"/"just now" claim in user-visible text.
    expect(text).not.toMatch(/Last checked:\s*just now/i);
    expect(text).not.toMatch(/['"][^"']*\b(?:live status|real-time status)\b[^"']*['"]/i);
  });
});

// ── 5. Voice biometric is NOT the production high-value step-up path ─────────

describe('noise audit · Voice biometric is not the production primary auth', () => {
  it('AuthGate.jsx adaptive ladder does NOT include "voice" as a required step', () => {
    const text = stripComments(read('src/components/security/AuthGate.jsx'));
    // No `requiredAuth = [..., 'voice', ...]` literal — voice must not be on
    // the adaptive/HIGH-risk ladder. (BiometricStepUpModal + the server
    // WebAuthn challenge is the canonical high-value step-up path.)
    expect(text).not.toMatch(/requiredAuth\s*=\s*\[[^\]]*['"]voice['"][^\]]*\]/);
  });

  it('VoiceBiometric.jsx still surfaces its honest "preview" disclaimer', () => {
    const text = stripComments(read('src/components/auth/VoiceBiometric.jsx'));
    expect(text).toMatch(/Voice verification preview|voiceprint check/i);
  });

  it('WalletTransfer.jsx promotes "Confirm & Send" as the primary CTA, not voice', () => {
    const text = stripComments(read('src/components/wallet/WalletTransfer.jsx'));
    expect(text).toMatch(/Confirm & Send/);
    // Voice option, if shown, is explicitly gated behind a non-hardened policy
    // check (Labs/dev surfaces only).
    expect(text).toMatch(/getClientDemoPolicy\(\)\.hardenedSurface/);
    // Voice CTA must not be the primary `gradient-green` button.
    expect(text).not.toMatch(/Voice Authenticate & Send/);
  });
});

// ── 6. Honest preview disclaimers still present for local-only features ──────

describe('noise audit · honest preview disclaimers retained', () => {
  const PREVIEW_INVARIANTS = [
    ['src/pages/Wallet.jsx',                              /Wallet preview/i],
    ['src/pages/Schedules.jsx',                           /Standing orders preview/i],
    ['src/pages/Notifications.jsx',                       /Notifications preview/i],
    ['src/components/rewards/RewardsDashboard.jsx',       /Rewards preview/i],
    ['src/components/wallet/LinkWalletModal.jsx',         /Preview link only/i],
    ['src/pages/NetworkStatus.jsx',                       /Network snapshot/i],
  ];

  it.each(PREVIEW_INVARIANTS)('%s still surfaces its honest preview disclaimer', (file, pattern) => {
    const text = stripComments(read(file));
    expect(text).toMatch(pattern);
  });

  it('Rewards toast still names "awaiting backend fulfillment" honestly', () => {
    const text = stripComments(read('src/components/rewards/RewardsDashboard.jsx'));
    expect(text).toMatch(/awaiting backend fulfillment|pending backend|fulfillment/i);
  });

  it('Schedules banner still names "no automatic payments"', () => {
    const text = stripComments(read('src/pages/Schedules.jsx'));
    expect(text).toMatch(/no automatic payments/i);
  });
});

// ── 7. Dev-only chips/hints are env-gated, never visible in hardened bundles ─

describe('noise audit · dev-only chips are env-gated', () => {
  it('PinPad "default PIN" hint is gated behind getClientDemoPolicy().allowDefaultDemoPin', () => {
    const text = stripComments(read('src/components/security/PinPad.jsx'));
    expect(text).toMatch(/getClientDemoPolicy\(\)\.allowDefaultDemoPin/);
    // The demo PIN hint (enter 123456) must appear in the gated branch only.
    const idx = text.search(/enter 123456/);
    expect(idx, '"enter 123456" string must exist somewhere (the gated branch)').toBeGreaterThan(-1);
    const window = text.slice(Math.max(0, idx - 400), idx);
    expect(window).toMatch(/allowDefaultDemoPin/);
  });

  it('FaceID camera preview disclaimer is gated behind getClientDemoPolicy().allowBiometricClientSimulation', () => {
    const text = stripComments(read('src/components/auth/FaceID.jsx'));
    expect(text).toMatch(/getClientDemoPolicy\(\)\.allowBiometricClientSimulation/);
  });

  it('BalanceCard "Sample data" / pitch financials chip is environment-gated', () => {
    const text = stripComments(read('src/components/home/BalanceCard.jsx'));
    expect(text).toMatch(/VITE_ALLOW_CLIENT_DEMO_CONTROLS/);
    expect(text).toMatch(/appEnv === 'local' \|\| appEnv === 'demo'/);
  });
});
