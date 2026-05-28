import { z } from 'zod';

export const APP_ENV_VALUES = ['local', 'demo', 'development', 'staging', 'production'];

export const clientEnvSchema = z.object({
  VITE_APP_ENV: z.enum(APP_ENV_VALUES).default('local'),
  VITE_SUPABASE_URL: z.string().optional().default(''),
  VITE_SUPABASE_ANON_KEY: z.string().optional().default(''),
  VITE_API_BASE_URL: z.string().optional().default(''),
  VITE_STRICT_ENV: z.enum(['true', 'false']).optional(),
  /** When `false`, disables local demo fallback behaviors (idempotency prefix, demo boot metric). */
  VITE_DEMO_FALLBACK: z.enum(['true', 'false']).optional(),
  /**
   * When `true`, allows client-side demo tooling in a non-dev Vite bundle (e.g. `vite preview`).
   * Ignored on staging/production `VITE_APP_ENV` or when `VITE_STRICT_ENV=true`.
   */
  VITE_ALLOW_CLIENT_DEMO_CONTROLS: z.enum(['true', 'false']).optional(),
});

export function coerceEnv(metaEnv) {
  const raw = typeof metaEnv === 'object' && metaEnv !== null ? metaEnv : {};
  return clientEnvSchema.parse({
    VITE_APP_ENV: raw.VITE_APP_ENV,
    VITE_SUPABASE_URL: raw.VITE_SUPABASE_URL,
    VITE_SUPABASE_ANON_KEY: raw.VITE_SUPABASE_ANON_KEY,
    VITE_API_BASE_URL: raw.VITE_API_BASE_URL,
    VITE_STRICT_ENV: raw.VITE_STRICT_ENV,
    VITE_DEMO_FALLBACK: raw.VITE_DEMO_FALLBACK,
    VITE_ALLOW_CLIENT_DEMO_CONTROLS: raw.VITE_ALLOW_CLIENT_DEMO_CONTROLS,
  });
}

export function requireProductionSecrets(parsed, mode) {
  const strict =
    parsed.VITE_STRICT_ENV === 'true' ||
    parsed.VITE_APP_ENV === 'staging' ||
    parsed.VITE_APP_ENV === 'production' ||
    mode === 'production';

  if (!strict) return { ok: true, errors: [] };

  const errors = [];
  const url = String(parsed.VITE_SUPABASE_URL || '');
  if (!url.startsWith('https://')) {
    errors.push('VITE_SUPABASE_URL must be an https URL.');
  }
  if (!parsed.VITE_SUPABASE_ANON_KEY || String(parsed.VITE_SUPABASE_ANON_KEY).length < 20) {
    errors.push('VITE_SUPABASE_ANON_KEY must be set (anon key).');
  }
  const apiBase = String(parsed.VITE_API_BASE_URL || '').trim();
  if (apiBase && !apiBase.startsWith('https://')) {
    errors.push('VITE_API_BASE_URL must be an https URL when set.');
  }
  // Strict envs MUST opt-in to VITE_STRICT_ENV=true so deploys cannot
  // silently fall through to development defaults.
  if (parsed.VITE_STRICT_ENV !== 'true') {
    errors.push('VITE_STRICT_ENV must be "true" in production/staging.');
  }
  // Demo controls are NEVER allowed in production/staging — even if a
  // human accidentally sets the flag.
  if (parsed.VITE_ALLOW_CLIENT_DEMO_CONTROLS === 'true') {
    errors.push('VITE_ALLOW_CLIENT_DEMO_CONTROLS must NOT be enabled in production/staging.');
  }
  return { ok: errors.length === 0, errors };
}

// ── VITE_* secret leakage scan ────────────────────────────────────────────
/**
 * Keys that must NEVER be exposed as VITE_* because Vite bakes them into the
 * browser bundle. Keep in sync with scripts/validate-env.mjs.
 */
export const FORBIDDEN_VITE_KEYS = Object.freeze([
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
]);

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
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /^sk_live_[0-9a-zA-Z]{20,}/,
  /^sb_secret_/i,
  /^AKIA[0-9A-Z]{16}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
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

/**
 * Scans an env-shaped object (typically import.meta.env or process.env) for
 * VITE_* leaks. Returns { ok, errors }. Used by validate-env.mjs and by the
 * client envSchema at boot.
 */
export function scanForViteSecretLeaks(envObj) {
  const errors = [];
  for (const key of FORBIDDEN_VITE_KEYS) {
    const v = envObj?.[key];
    if (v !== undefined && String(v).trim() !== '') {
      errors.push(`${key} must never be a VITE_* variable. Move it to Edge Function secrets.`);
    }
  }
  for (const [key, raw] of Object.entries(envObj || {})) {
    if (!key.startsWith('VITE_')) continue;
    if (VITE_ALLOWLIST.has(key)) continue;
    if (SECRET_NAME_PATTERNS.some((re) => re.test(key))) {
      errors.push(`${key} has a secret-looking name and is exposed as VITE_*.`);
      continue;
    }
    const value = String(raw ?? '');
    if (value && SECRET_VALUE_PATTERNS.some((re) => re.test(value))) {
      errors.push(`${key} contains a secret-looking value and is exposed as VITE_*.`);
    }
  }
  return { ok: errors.length === 0, errors };
}
