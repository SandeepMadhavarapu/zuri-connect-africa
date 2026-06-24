#!/usr/bin/env node
/**
 * Zuri Connect Africa — pre-pitch / pre-deployment security check.
 *
 * Run with: node scripts/check-prepitch.mjs
 *
 * Verifies:
 *   1. No forbidden secret-looking VITE_* env vars are set.
 *   2. No wildcard CORS in security/payment Edge Functions.
 *   3. .gitignore covers .env*, node_modules, dist, supabase/.temp.
 *   4. SETUP.md mentions the packaging checklist items.
 *   5. .env.example doesn't ship a real secret (already covered by scan-secrets,
 *      this is just a final sanity check).
 *
 * Designed to fail closed: any check failing exits 1 with a clear message.
 * Safe to run from CI, dev machines, and the Vercel / Docker build.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const failures = [];
const warnings = [];

function fail(msg)  { failures.push(msg); }
function warn(msg)  { warnings.push(msg); }
function ok(label)  { console.log(`  \u2713 ${label}`); }

// ── 1. VITE_* secret-leakage scan ────────────────────────────────────────
const FORBIDDEN_VITE = [
  'VITE_SUPABASE_SERVICE_ROLE_KEY',
  'VITE_SUPABASE_SERVICE_KEY',
  'VITE_SERVICE_ROLE_KEY',
  'VITE_DARAJA_CONSUMER_KEY',
  'VITE_DARAJA_CONSUMER_SECRET',
  'VITE_DARAJA_PASSKEY',
  'VITE_DARAJA_SHORTCODE',
  'VITE_MPESA_PASSKEY',
  'VITE_MPESA_CONSUMER_SECRET',
  'VITE_MPESA_WEBHOOK_SECRET',
  'VITE_WEBHOOK_SECRET',
  'VITE_AT_API_KEY',
  'VITE_AFRICASTALKING_API_KEY',
  'VITE_OTP_PEPPER',
  'VITE_PIN_PEPPER',
  'VITE_OPENAI_API_KEY',
  'VITE_ANTHROPIC_API_KEY',
  'VITE_GEMINI_API_KEY',
  'VITE_GOOGLE_API_KEY',
];

console.log('[prepitch] 1/5 Scanning environment for VITE_* secret leaks…');
let leaks = 0;
for (const key of FORBIDDEN_VITE) {
  const v = process.env[key];
  if (v !== undefined && String(v).trim() !== '') {
    fail(`Forbidden VITE_* secret leak: ${key} is set in current environment.`);
    leaks += 1;
  }
}
const SECRET_NAME_RE  = /(service[_-]?role|secret|passkey|pepper|api[_-]?key$|private[_-]?key|webhook[_-]?secret)/i;
const VITE_ALLOWLIST  = new Set([
  'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_APP_ENV', 'VITE_STRICT_ENV', 'VITE_ALLOW_CLIENT_DEMO_CONTROLS',
  'VITE_DEMO_FALLBACK', 'VITE_API_BASE_URL',
]);
for (const key of Object.keys(process.env)) {
  if (!key.startsWith('VITE_')) continue;
  if (VITE_ALLOWLIST.has(key)) continue;
  if (SECRET_NAME_RE.test(key)) {
    fail(`Secret-looking VITE_* variable: ${key} would be shipped to the browser.`);
    leaks += 1;
  }
}
if (leaks === 0) ok('No VITE_* secret leaks detected.');

// ── 2. Wildcard CORS scan in sensitive Edge Functions ────────────────────
console.log('[prepitch] 2/5 Scanning Edge Functions for wildcard CORS…');
const SENSITIVE_FUNCTIONS = [
  'send-otp', 'verify-otp', 'set-pin', 'complete-step-up',
  'verify-biometric', 'ai-router', 'initiate-payment', 'webhook-handler',
  'reconciliation-job', 'settlement-recovery',
  'notification-dispatcher', 'admin-reconciliation',
];
const WILDCARD_RE = /'Access-Control-Allow-Origin'\s*:\s*['"]\*['"]/;
let wildcards = 0;
for (const fn of SENSITIVE_FUNCTIONS) {
  const file = join(ROOT, 'supabase', 'functions', fn, 'index.ts');
  if (!existsSync(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (WILDCARD_RE.test(text)) {
    fail(`Wildcard CORS in supabase/functions/${fn}/index.ts — must pin to APP_ORIGIN.`);
    wildcards += 1;
  }
}
if (wildcards === 0) ok('No wildcard CORS in sensitive Edge Functions.');

// ── 3. .gitignore coverage ───────────────────────────────────────────────
console.log('[prepitch] 3/5 Verifying .gitignore covers env files, node_modules, dist, supabase/.temp…');
const gitignorePath = join(ROOT, '.gitignore');
let gitignoreOk = true;
if (!existsSync(gitignorePath)) {
  fail('.gitignore is missing.');
  gitignoreOk = false;
} else {
  const gi = readFileSync(gitignorePath, 'utf8');
  const must = ['.env', '.env.local', '.env.*.local', 'node_modules', 'dist', 'supabase/.temp'];
  for (const entry of must) {
    if (!gi.split(/\r?\n/).some((line) => line.trim() === entry)) {
      fail(`.gitignore is missing required entry: ${entry}`);
      gitignoreOk = false;
    }
  }
}
if (gitignoreOk) ok('.gitignore covers env files, node_modules, dist, supabase/.temp.');

// ── 4. SETUP.md packaging checklist ──────────────────────────────────────
console.log('[prepitch] 4/5 Verifying SETUP.md mentions the packaging checklist…');
const setupPath = join(ROOT, 'SETUP.md');
let setupOk = true;
if (!existsSync(setupPath)) {
  fail('SETUP.md is missing.');
  setupOk = false;
} else {
  const setup = readFileSync(setupPath, 'utf8');
  const requiredMentions = [
    '.env.local',
    'node_modules',
    'dist',
    'secrets',
    'VITE_STRICT_ENV',
    'WEBHOOK_SKIP_SIGNATURE',
  ];
  for (const m of requiredMentions) {
    if (!setup.includes(m)) {
      fail(`SETUP.md packaging checklist is missing required mention: ${m}`);
      setupOk = false;
    }
  }
}
if (setupOk) ok('SETUP.md packaging checklist references the required items.');

// ── 5. .env.example sanity (no real secrets) ─────────────────────────────
console.log('[prepitch] 5/5 Checking .env.example for accidentally-committed real secrets…');
const examplePath = join(ROOT, '.env.example');
let exampleOk = true;
if (existsSync(examplePath)) {
  const text = readFileSync(examplePath, 'utf8');
  const realSecretRe = [
    /^VITE_SUPABASE_ANON_KEY=eyJ[A-Za-z0-9_-]{20,}/m,
    /sk_live_[0-9a-zA-Z]{20,}/,
    /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  ];
  for (const re of realSecretRe) {
    if (re.test(text)) {
      fail(`.env.example appears to contain real secret material (${re}). Replace with a placeholder.`);
      exampleOk = false;
    }
  }
}
if (exampleOk) ok('.env.example has no real-secret values.');

// ── 6. Pitch-honesty scan of src/pages and src/components ────────────────
//
// Static scan that forbids overclaim phrases from leaking into user-visible
// JSX. We deliberately keep this list short and high-signal so the script
// stays a fast pre-commit aid.
console.log('[prepitch] 6/7 Scanning src/pages + src/components for overclaim phrases…');
const PITCH_FORBIDDEN = [
  { needle: 'PCI-DSS L1',           reason: 'PCI-DSS Level 1 is a certification claim that must not appear without proof.' },
  { needle: 'PCI DSS L1',           reason: 'PCI-DSS Level 1 is a certification claim that must not appear without proof.' },
  { needle: 'KYC Tier 3',           reason: 'KYC Tier 3 is a regulatory-tier claim that must not appear without proof.' },
  { needle: 'NID Verified',         reason: 'NID Verified implies a NID integration that this build does not have.' },
  { needle: 'production-ready',     reason: '"production-ready" must not appear in user-visible copy unless deployment evidence is attached.' },
  { needle: 'Production-ready',     reason: '"production-ready" must not appear in user-visible copy unless deployment evidence is attached.' },
  { needle: 'Production Ready',     reason: '"production-ready" must not appear in user-visible copy unless deployment evidence is attached.' },
];

function pitchWalk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) pitchWalk(full, out);
    else if (['.jsx', '.tsx', '.js', '.ts'].includes(extname(name))) out.push(full);
  }
  return out;
}

function stripJsComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const PITCH_DIRS = ['src/pages', 'src/components', 'src/lib'];
const pitchFiles = PITCH_DIRS.flatMap((d) => pitchWalk(resolve(ROOT, d)));
let pitchOk = true;
const pitchHits = [];
for (const file of pitchFiles) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  const visible = stripJsComments(text);
  for (const { needle, reason } of PITCH_FORBIDDEN) {
    if (visible.includes(needle)) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      pitchHits.push({ rel, needle, reason });
      pitchOk = false;
    }
  }
  // "Dev only: default PIN" must never appear in production-visible JSX. We
  // tolerate the substring if it appears in a gated branch — heuristic: the
  // same file must mention `allowDefaultDemoPin` within 600 chars before it.
  const devPinIdx = visible.indexOf('Dev only: default PIN');
  if (devPinIdx !== -1) {
    const window = visible.slice(Math.max(0, devPinIdx - 600), devPinIdx);
    if (!window.includes('allowDefaultDemoPin')) {
      const rel = relative(ROOT, file).replaceAll('\\', '/');
      pitchHits.push({ rel, needle: 'Dev only: default PIN', reason: 'Un-gated default PIN hint — must sit behind getClientDemoPolicy().allowDefaultDemoPin.' });
      pitchOk = false;
    }
  }
}
if (pitchOk) ok('No PCI-DSS L1 / KYC Tier 3 / NID Verified / production-ready / un-gated default-PIN phrases.');
else {
  for (const h of pitchHits) fail(`Pitch overclaim in ${h.rel}: "${h.needle}" — ${h.reason}`);
}

// ── 7. Budget honest-disclaimer presence ─────────────────────────────────
//
// The Home directory-preview banner check was removed: the EcosystemGrid
// PayBill directory it disclaimed was intentionally dropped from the Hesabu
// surface, so the banner is correctly absent. The Budget sample/preview
// disclaimer remains a separate, still-valid check (dormant until Budget.jsx
// exists, then enforced).
console.log('[prepitch] 7/7 Verifying Budget sample disclaimer present…');
const BUDGET_FILE = join(ROOT, 'src', 'pages', 'Budget.jsx');
let disclaimersOk = true;
if (existsSync(BUDGET_FILE)) {
  const txt = readFileSync(BUDGET_FILE, 'utf8');
  if (!/sample data/i.test(txt) || !/Preview analysis/i.test(txt)) {
    fail('src/pages/Budget.jsx is missing the sample/preview disclaimer.');
    disclaimersOk = false;
  }
}
if (disclaimersOk) ok('Budget sample disclaimer present.');

console.log('');
if (warnings.length) {
  console.log('[prepitch] warnings:');
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (failures.length) {
  console.error('[prepitch] FAIL:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[prepitch] OK — pre-pitch security checks passed.');
process.exit(0);
