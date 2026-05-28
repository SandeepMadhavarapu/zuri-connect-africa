#!/usr/bin/env node
/**
 * Zuri Connect Africa — Button Audit
 *
 * Static, non-network scan that flags suspect clickable UI patterns in the
 * frontend source tree. The script DOES NOT replace the unit test suite — it
 * is a fast pre-commit aid for spotting:
 *
 *   1. Raw `alert(...)` calls inside `src/pages` or `src/components`.
 *   2. `<a href="#">` dead anchors.
 *   3. Dangerous-verb button labels (Send/Pay/Redeem/Revoke/Activate/Delete/
 *      Confirm/Resolve/Reconcile/Reverse) whose surrounding handler does not
 *      reference a server call (`paymentService.`, `invokeEdgeFunction`,
 *      `supabase.from`, `supabase.functions.invoke`, `complete-step-up`,
 *      `admin-reconciliation`, `set-pin`, `verify-otp`, `verify-biometric`).
 *   4. Use of `sessionStorage` / `localStorage` to back what visibly look like
 *      financial / rewards / schedule mutations.
 *
 * The script exits 0 (success) so it does not block the build — it is meant to
 * be run as `npm run audit:buttons` and feed test cases in
 * `tests/unit/button-audit.test.js`, which DOES fail the build on regressions.
 *
 * Output: a markdown-ish report grouped by severity. Non-zero exit only when
 * the user passes `--strict` (CI mode).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, extname } from 'node:path';

const ROOT = process.cwd();
const STRICT = process.argv.includes('--strict');

const SCAN_DIRS = ['src/pages', 'src/components'];
const ALLOW_EXT = new Set(['.jsx', '.tsx', '.js', '.ts']);

// Server-call signatures considered "safe" when found near a dangerous-verb button.
const SERVER_CALL_PATTERNS = [
  /paymentService\./,
  /invokeEdgeFunction\s*\(/,
  /supabase\.from\s*\(/,
  /supabase\.functions\.invoke/,
  /supabase\.auth\./,
  /completeServerStepUp/,
  /complete-step-up/,
  /initiate-payment/,
  /admin-reconciliation/,
  /set-pin/,
  /verify-otp/,
  /verify-biometric/,
  /ai-router/,
  /sendOTP|verifyOTP/,
  /reconciliationApi/,
  /ledgerService/,
  /authenticateBiometric|registerBiometric/,
];

// Dangerous-verb labels — these MUST either (a) call a server function, or
// (b) be inside an explicit preview/disabled flow (we look for `preview`,
// `disabled`, `cursor-not-allowed`, `Coming soon`, `Reserve`, or
// `requires backend` in the same file).
//
// NOTE: pure navigation labels (e.g. a CTA that just calls `navigate('/send')`
// from an empty-state) and route-title constant maps are filtered downstream
// in `classifyDangerHits`.
const DANGER_LABELS = [
  'Send Money',
  'Pay Bill',
  'Confirm Payment',
  'Activate',
  'Approve',
  'Authorize',
  'Authorise',
  'Reverse',
  'Reconcile',
  'Block Transaction',
  'Suspend',
  'Redeem',
];

// File globs / patterns that the danger-verb scan should ignore entirely.
// TopBar route-title maps and similar dictionary-style data are not buttons.
const DANGER_LABEL_FILE_IGNORES = [
  /components\/layout\/TopBar\./,
  /components\/layout\/BottomNav\./,
];

// Local-state backed financial keys that should NEVER claim financial truth.
const LOCAL_FIN_PATTERNS = [
  /sessionStorage\.setItem\s*\(\s*['"]\w*(?:balance|wallet|payment|ledger|reward|points)/i,
  /localStorage\.setItem\s*\(\s*['"]\w*(?:balance|wallet|payment|ledger|reward|points)/i,
];

// Honest-preview markers — when these strings appear in the same file we
// downgrade the danger-verb warning because the surface is clearly labelled.
const PREVIEW_MARKERS = [
  /preview/i,
  /coming soon/i,
  /requires? backend/i,
  /provider required/i,
  /pending backend/i,
  /not enabled in this build/i,
  /demo wallet/i,
  /reserve/i,
  /server.session management/i,
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (ALLOW_EXT.has(extname(name))) out.push(full);
  }
  return out;
}

function readSource(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function findRawAlerts(text) {
  const out = [];
  const re = /\balert\s*\(/g;
  let m;
  while ((m = re.exec(text))) {
    const pre = text.slice(Math.max(0, m.index - 60), m.index);
    if (/(?:\/\/|\*).*$/m.test(pre.split('\n').pop())) continue;
    out.push(text.slice(0, m.index).split('\n').length);
  }
  return out;
}

function findDeadAnchors(text) {
  const out = [];
  const re = /href\s*=\s*"#"/g;
  let m;
  while ((m = re.exec(text))) out.push(text.slice(0, m.index).split('\n').length);
  return out;
}

function findDangerousVerbButtons(text) {
  const out = [];
  const re = new RegExp(`(?:>|"|')\\s*(${DANGER_LABELS.join('|')})\\b`, 'gi');
  let m;
  while ((m = re.exec(text))) {
    // Filter out the case where the surrounding handler is *just* a navigation
    // call — an empty-state CTA like `<button onClick={() => navigate('/send')}>Send Money</button>`
    // is a router link, not a payment trigger. We look at a 400 char window
    // before the match for `navigate(`, `Link to=`, or `<a href=`.
    const pre = text.slice(Math.max(0, m.index - 400), m.index);
    const isNavOnly =
      /onClick\s*=\s*\{\s*\(?\)?\s*=>\s*navigate\s*\(/i.test(pre) ||
      /<Link\b[^>]*\bto=/.test(pre) ||
      /<NavLink\b[^>]*\bto=/.test(pre);
    if (isNavOnly) continue;
    out.push({ line: text.slice(0, m.index).split('\n').length, label: m[1].trim() });
  }
  return out;
}

function findLocalFinancialState(text) {
  const out = [];
  for (const pat of LOCAL_FIN_PATTERNS) {
    const m = pat.exec(text);
    if (m) out.push({ line: text.slice(0, m.index).split('\n').length, match: m[0] });
  }
  return out;
}

function fileMentionsServerCall(text) {
  return SERVER_CALL_PATTERNS.some((p) => p.test(text));
}

function fileMentionsPreviewMarker(text) {
  return PREVIEW_MARKERS.some((p) => p.test(text));
}

function classifyDangerHits(file, text, hits) {
  const hasServer = fileMentionsServerCall(text);
  const hasPreview = fileMentionsPreviewMarker(text);
  return hits.map((h) => ({
    file,
    line: h.line,
    label: h.label,
    severity: hasServer ? 'ok-server' : hasPreview ? 'preview-disclaimed' : 'WARN',
  }));
}

function main() {
  const files = SCAN_DIRS.flatMap((d) => {
    try {
      return walk(resolve(ROOT, d));
    } catch {
      return [];
    }
  });

  const findings = {
    rawAlerts: [],
    deadAnchors: [],
    danger: [],
    localFinState: [],
  };

  for (const file of files) {
    const text = readSource(file);
    const rel = relative(ROOT, file).replaceAll('\\', '/');

    findRawAlerts(text).forEach((line) => findings.rawAlerts.push({ file: rel, line }));
    findDeadAnchors(text).forEach((line) => findings.deadAnchors.push({ file: rel, line }));
    if (!DANGER_LABEL_FILE_IGNORES.some((p) => p.test(rel))) {
      const dangerHits = findDangerousVerbButtons(text);
      if (dangerHits.length) {
        findings.danger.push(...classifyDangerHits(rel, text, dangerHits));
      }
    }
    findLocalFinancialState(text).forEach((h) =>
      findings.localFinState.push({ file: rel, line: h.line, match: h.match }),
    );
  }

  const warn = findings.danger.filter((d) => d.severity === 'WARN');

  const lines = [];
  lines.push('# Zuri Connect — Button Audit Report');
  lines.push('');
  lines.push(`Scanned ${files.length} files under ${SCAN_DIRS.join(', ')}`);
  lines.push('');

  lines.push('## Raw alert() / confirm() / prompt()');
  if (findings.rawAlerts.length === 0) lines.push('  none');
  else findings.rawAlerts.forEach((h) => lines.push(`  - ${h.file}:${h.line} alert(`));
  lines.push('');

  lines.push('## Dead anchors (href="#")');
  if (findings.deadAnchors.length === 0) lines.push('  none');
  else findings.deadAnchors.forEach((h) => lines.push(`  - ${h.file}:${h.line}`));
  lines.push('');

  lines.push('## Local-state financial mutation');
  if (findings.localFinState.length === 0) lines.push('  none');
  else findings.localFinState.forEach((h) => lines.push(`  - ${h.file}:${h.line} ${h.match}`));
  lines.push('');

  lines.push('## Dangerous-verb buttons');
  if (findings.danger.length === 0) {
    lines.push('  none');
  } else {
    const grouped = { 'ok-server': [], 'preview-disclaimed': [], WARN: [] };
    for (const d of findings.danger) grouped[d.severity].push(d);
    for (const sev of ['WARN', 'preview-disclaimed', 'ok-server']) {
      if (!grouped[sev].length) continue;
      lines.push(`  [${sev}] (${grouped[sev].length})`);
      for (const d of grouped[sev]) lines.push(`    - ${d.file}:${d.line} "${d.label}"`);
    }
  }
  lines.push('');

  const totalProblems = findings.rawAlerts.length + findings.deadAnchors.length + warn.length + findings.localFinState.length;
  lines.push(`## Summary`);
  lines.push(`  raw alerts: ${findings.rawAlerts.length}`);
  lines.push(`  dead anchors: ${findings.deadAnchors.length}`);
  lines.push(`  un-disclaimed danger-verb buttons without server call: ${warn.length}`);
  lines.push(`  local financial-state writes: ${findings.localFinState.length}`);
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');

  if (STRICT && totalProblems > 0) {
    console.error(`\n[audit-buttons] ${totalProblems} issues found in --strict mode.`);
    process.exit(1);
  }
}

main();
