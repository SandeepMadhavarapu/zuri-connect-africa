#!/usr/bin/env node
/**
 * CI / Docker: validate required VITE_* vars before build or deploy.
 * Usage: node scripts/validate-env.mjs [--strict]
 *
 * Strict rules (production / staging):
 *   * VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (or VITE_SUPABASE_PUBLISHABLE_KEY) must be set.
 *   * VITE_APP_ENV must be set.
 *   * VITE_STRICT_ENV must be 'true'.
 *   * VITE_ALLOW_CLIENT_DEMO_CONTROLS must NOT be 'true'.
 *
 * Secret leakage rules (every environment):
 *   * No VITE_ variable may contain values that look like service-role keys,
 *     Daraja secrets, AT keys, OTP/PIN peppers, AI provider keys, or webhook
 *     secrets. VITE_ is shipped to the browser and must never carry those.
 */

const args = process.argv.slice(2);
const strictFlag = args.includes('--strict');
const env = process.env;
const appEnv = (env.VITE_APP_ENV || 'development').toLowerCase();

const log   = (msg) => console.log(`[validate-env] ${msg}`);
const warn  = (msg) => console.warn(`[validate-env] WARN: ${msg}`);
const fail  = (msg) => { console.error(`[validate-env] FAIL: ${msg}`); process.exit(1); };

const isProductionTier = strictFlag || appEnv === 'staging' || appEnv === 'production';

// ── 1. Required-shape rules ────────────────────────────────────────────────
const requiredAlways = ['VITE_APP_ENV'];
const requiredProd   = [
  'VITE_SUPABASE_URL',
  'VITE_STRICT_ENV',
];

const errors = [];

for (const key of requiredAlways) {
  if (!String(env[key] || '').trim()) errors.push(`${key} is required`);
}

if (isProductionTier) {
  for (const key of requiredProd) {
    if (!String(env[key] || '').trim()) errors.push(`${key} is required in ${appEnv}`);
  }
  // Anon key OR publishable key must be present.
  const hasAnon       = String(env.VITE_SUPABASE_ANON_KEY || '').trim().length >= 20;
  const hasPublishable = String(env.VITE_SUPABASE_PUBLISHABLE_KEY || '').trim().length >= 20;
  if (!hasAnon && !hasPublishable) {
    errors.push('VITE_SUPABASE_ANON_KEY or VITE_SUPABASE_PUBLISHABLE_KEY must be set');
  }

  if (String(env.VITE_STRICT_ENV || '').toLowerCase() !== 'true') {
    errors.push('VITE_STRICT_ENV must be "true" in production/staging');
  }
  if (String(env.VITE_ALLOW_CLIENT_DEMO_CONTROLS || '').toLowerCase() === 'true') {
    errors.push('VITE_ALLOW_CLIENT_DEMO_CONTROLS must NOT be "true" in production/staging');
  }
} else if (!strictFlag && appEnv !== 'staging' && appEnv !== 'production') {
  log(`Non-strict mode for ${appEnv}; only checking shape rules.`);
}

// ── 2. URL/key shape ──────────────────────────────────────────────────────
const url = String(env.VITE_SUPABASE_URL || '').trim();
if (url && !url.startsWith('https://')) {
  errors.push('VITE_SUPABASE_URL must be an https URL');
}
const anon = String(env.VITE_SUPABASE_ANON_KEY || '').trim();
if (anon && anon.length < 20) {
  errors.push('VITE_SUPABASE_ANON_KEY is too short to be a valid Supabase anon key');
}

// ── 3. VITE_* secret leakage scan ─────────────────────────────────────────
// VITE_ values are baked into the browser bundle. These keys must NEVER appear.
const FORBIDDEN_VITE_KEYS = [
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

for (const key of FORBIDDEN_VITE_KEYS) {
  if (env[key] !== undefined && String(env[key]).trim() !== '') {
    errors.push(`${key} must never be a VITE_* variable — it is shipped to the browser. Move it to Supabase Edge Function secrets.`);
  }
}

// Heuristic: any VITE_* whose NAME or VALUE matches a known-secret pattern.
const SECRET_NAME_PATTERNS = [
  /service[_-]?role/i,
  /secret/i,
  /passkey/i,
  /pepper/i,
  /api[_-]?key$/i,
  /private[_-]?key/i,
  /webhook[_-]?secret/i,
];
const SECRET_VALUE_PATTERNS = [
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
  /^sk_live_[0-9a-zA-Z]{20,}/,                                       // Stripe live
  /^sb_secret_/i,                                                    // Supabase service key
  /^AKIA[0-9A-Z]{16}/,                                              // AWS
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,                // PEM
];
const VITE_ALLOWLIST = new Set([
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_APP_ENV',
  'VITE_STRICT_ENV',
  'VITE_ALLOW_CLIENT_DEMO_CONTROLS',
  'VITE_DEMO_FALLBACK',
  'VITE_API_BASE_URL',
]);

for (const [key, rawValue] of Object.entries(env)) {
  if (!key.startsWith('VITE_')) continue;
  if (VITE_ALLOWLIST.has(key)) continue;
  // VITE_SUPABASE_ANON_KEY is a JWT but is explicitly browser-safe (public anon).
  const value = String(rawValue ?? '');
  if (SECRET_NAME_PATTERNS.some((re) => re.test(key))) {
    errors.push(`${key} has a secret-looking name and is exposed as VITE_*. Move it to Edge Function secrets.`);
    continue;
  }
  if (value && SECRET_VALUE_PATTERNS.some((re) => re.test(value))) {
    errors.push(`${key} contains a value that looks like a secret credential and is exposed as VITE_*.`);
  }
}

if (errors.length > 0) {
  for (const err of errors) console.error(`[validate-env] ${err}`);
  process.exit(1);
}

if (url && !url.includes('supabase.co')) {
  warn('VITE_SUPABASE_URL does not contain supabase.co (custom domain or self-hosted is OK if intentional).');
}

log('OK');
process.exit(0);
