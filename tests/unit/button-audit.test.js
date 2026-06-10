/**
 * Button audit test suite
 *
 * Goal: lock in the invariants that fixing the broken/local-only buttons
 * established. If a future change re-introduces a raw `alert(`, a dead
 * `Revoke` button, a `Wallet Linked!` style fake-success copy, or a financial
 * verb that no longer maps to a server call, this test fails fast.
 *
 * The checks are deliberately STATIC source scans (no rendering, no Supabase)
 * so they remain dependency-free and run in milliseconds.
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

const PAGE_DIR = resolve(ROOT, 'src/pages');
const COMPONENT_DIR = resolve(ROOT, 'src/components');

const PAGE_FILES = walk(PAGE_DIR);
const COMPONENT_FILES = walk(COMPONENT_DIR);
const ALL_UI_FILES = [...PAGE_FILES, ...COMPONENT_FILES];

describe('button audit · no raw alert() in production UI', () => {
  it('src/pages and src/components contain zero raw alert(/confirm(/prompt( in click paths', () => {
    const offenders = [];
    for (const file of ALL_UI_FILES) {
      const text = stripComments(read(file));
      if (/\balert\s*\(/.test(text)) offenders.push(`${relative(ROOT, file)} :: alert(`);
      // confirm()/prompt() are also forbidden as native blocking dialogs.
      if (/\bwindow\.confirm\s*\(/.test(text)) offenders.push(`${relative(ROOT, file)} :: window.confirm(`);
      if (/\bwindow\.prompt\s*\(/.test(text)) offenders.push(`${relative(ROOT, file)} :: window.prompt(`);
    }
    expect(offenders, `Forbidden native dialogs in production UI: ${offenders.join(', ')}`).toEqual([]);
  });
});

describe('button audit · no dead handlers on critical buttons', () => {
  it('SecurityCentre Revoke button has an explicit handler', () => {
    const text = read('src/pages/SecurityCentre.jsx');
    // The Revoke button must call a handler. Now backend-backed: it routes
    // through `revokeDeviceServer` (security-devices Edge Function) and the
    // copy honestly surfaces the Supabase auth limitation that an active
    // session may persist until the refresh token expires.
    const stripped = stripComments(text);
    const revokeButton = stripped.match(/<button[\s\S]{0,800}?>\s*Revoke\s*<\/button>/);
    expect(revokeButton, 'Revoke button must exist in Sessions tab').not.toBeNull();
    expect(revokeButton[0]).toMatch(/onClick\s*=\s*\{/);
    expect(stripped).toMatch(/revokeDeviceServer/);
    expect(stripped).toMatch(/active session may remain|refresh token expires|server.managed/i);
  });

  it('SecurityCentre does not contain duplicate sessions tab blocks', () => {
    const text = stripComments(read('src/pages/SecurityCentre.jsx'));
    const matches = text.match(/activeTab\s*===\s*'sessions'/g) || [];
    expect(matches.length, 'Sessions tab block must appear exactly once').toBe(1);
  });

  it('Notifications Mark all read button has an onClick handler', () => {
    const text = stripComments(read('src/pages/Notifications.jsx'));
    const btn = text.match(/<button[\s\S]{0,400}?>\s*[\s\S]{0,80}?Mark all read[\s\S]{0,40}?<\/button>/);
    expect(btn, 'Mark all read button must exist').not.toBeNull();
    expect(btn[0]).toMatch(/onClick\s*=\s*\{/);
  });

  it('Notifications surface explicitly states read state is local-only', () => {
    const text = stripComments(read('src/pages/Notifications.jsx'));
    expect(text).toMatch(/preview/i);
    expect(text).toMatch(/(local|this device)/i);
  });

});

describe('button audit · honest preview labels for local-only flows', () => {
  it('Wallet page admits the wallet link is a preview, not a real Safaricom link', () => {
    const text = stripComments(read('src/pages/Wallet.jsx'));
    expect(text).toMatch(/preview/i);
    expect(text).not.toMatch(/\bLinked\s*✓/);
  });

  it('LinkWalletModal does not claim a real Safaricom account is linked', () => {
    const text = stripComments(read('src/components/wallet/LinkWalletModal.jsx'));
    expect(text).toMatch(/preview/i);
    expect(text).not.toMatch(/\bWallet Linked!?\s*<\/p>/);
    expect(text).not.toMatch(/Verifying with M-Pesa/);
  });

  it('Schedules page admits standing orders are local-only and do not auto-execute', () => {
    const text = stripComments(read('src/pages/Schedules.jsx'));
    expect(text).toMatch(/preview/i);
    expect(text).toMatch(/(no automatic payments|do NOT execute)/i);
  });

  it('AddScheduleModal CTA does not promise an active standing order', () => {
    const text = stripComments(read('src/components/schedules/AddScheduleModal.jsx'));
    expect(text).not.toMatch(/Create Standing Order/);
    expect(text).toMatch(/Save Schedule/);
  });

  it('RewardsDashboard redemption surface uses "Reserve" / "pending backend"', () => {
    const text = stripComments(read('src/components/rewards/RewardsDashboard.jsx'));
    expect(text).toMatch(/Reserve/);
    expect(text).toMatch(/pending backend|requires? .*backend|fulfillment/i);
    expect(text).not.toMatch(/\}\s*redeemed!/);
  });

  it('NetworkStatus page admits the status is a snapshot, not a live probe', () => {
    const text = stripComments(read('src/pages/NetworkStatus.jsx'));
    expect(text).toMatch(/snapshot/i);
    expect(text).not.toMatch(/Last checked:\s*just now/);
  });
});

describe('button audit · payment pages remain server-authoritative', () => {
  it('AIActionModal never claims to execute a payment from inside the modal', () => {
    const text = stripComments(read('src/components/ai/AIActionModal.jsx'));
    expect(text).not.toMatch(/Confirm — \$\{config\.label\}/);
    expect(text).toMatch(/proposal|No money moves/i);
  });
});

describe('button audit · admin actions are backend-backed', () => {
  it('ReconciliationCommandCenter mutations go through the admin Edge Function', () => {
    const text = stripComments(read('src/pages/admin/ReconciliationCommandCenter.jsx'));
    expect(text).toMatch(/markReviewResolved|escalateToSupport|markTimeoutAcknowledged|retryProviderQuery|rejectOrphanCallback/);
    // The admin reconciliation API client (which is imported here) is the
    // only safe entrypoint into admin-reconciliation Edge Function.
    expect(text).toMatch(/reconciliationApi|@\/lib\/admin/);
  });
});

describe('button audit · device trust is backend-backed but copy is honest', () => {
  it('DeviceTrustPanel revoke calls the backend AND clarifies remote sessions are not signed out', () => {
    const text = stripComments(read('src/components/security/DeviceTrustPanel.jsx'));
    // Backend wire-up — never trust the local registry alone.
    expect(text).toMatch(/revokeDeviceServer/);
    // Honest copy: revoke is real, but Supabase Auth cannot per-device
    // refresh-token revoke, so the active session may persist.
    expect(text).toMatch(/Remote sessions are not signed out|refresh token expires/i);
  });
});

describe('button audit · VoiceBiometric falls back without raw alert', () => {
  it('VoiceBiometric uses toast(), not alert(), when voice is not enrolled', () => {
    const text = stripComments(read('src/components/auth/VoiceBiometric.jsx'));
    expect(text).not.toMatch(/\balert\s*\(/);
    expect(text).toMatch(/toast\s*\(\s*\{[\s\S]*Voice not enrolled/);
  });
});

describe('button audit · audit script ships and is executable', () => {
  it('scripts/audit-buttons.mjs exists and exposes a default --strict flag', () => {
    const text = read('scripts/audit-buttons.mjs');
    expect(text).toMatch(/--strict/);
    expect(text).toMatch(/Button Audit/);
  });

  it('package.json declares the audit:buttons script', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['audit:buttons']).toBe('node scripts/audit-buttons.mjs');
    expect(pkg.scripts['audit:buttons:strict']).toBe('node scripts/audit-buttons.mjs --strict');
  });
});
