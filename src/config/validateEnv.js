/**
 * Zuri Connect Africa — startup / Supabase environment validation
 * Single source of truth for VITE_* checks, telemetry on failure, and bootstrap diagnostics.
 *
 * AI provider secrets (OpenAI, Anthropic, Gemini) belong in Supabase Edge / server env only — never VITE_*.
 */

import { coerceEnv, requireProductionSecrets, scanForViteSecretLeaks } from './envSchema.js';
import { METRICS, track } from '@/lib/observability/metrics.js';

export const STARTUP_ERROR_CODES = {
  ENV_PARSE: 'ENV_PARSE',
  MISSING_SUPABASE_URL: 'MISSING_SUPABASE_URL',
  MISSING_SUPABASE_ANON_KEY: 'MISSING_SUPABASE_ANON_KEY',
  STRICT_GATE: 'STRICT_GATE',
  PLACEHOLDER_CREDENTIALS: 'PLACEHOLDER_CREDENTIALS',
  VITE_SECRET_LEAK: 'VITE_SECRET_LEAK',
};

const PLACEHOLDER_VALUES = [
  'https://your-project-id.supabase.co',
  'your-anon-key-here',
  'REPLACE_ME',
  '',
];

function placeholderCredentialMessage() {
  return (
    '[ZuriConnect] Supabase credentials are not configured.\n' +
    'Copy .env.example to .env.local and fill in your real Supabase URL and anon key.\n' +
    'See SETUP.md for full instructions.'
  );
}

function usesPlaceholderCredentials(parsed) {
  const urlTrim = String(parsed.VITE_SUPABASE_URL ?? '').trim();
  const keyTrim = String(parsed.VITE_SUPABASE_ANON_KEY ?? '').trim();
  return PLACEHOLDER_VALUES.includes(urlTrim) || PLACEHOLDER_VALUES.includes(keyTrim);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emitConfigTelemetry(reason, codes, extra = {}) {
  try {
    track(METRICS.STARTUP_CONFIG_FAILURE, 1, { reason, codes: codes.join(','), ...extra });
  } catch {
    /* observability must not break bootstrap */
  }
}

/**
 * Full startup validation. Does not throw — use `shouldBlockApp` to gate rendering.
 * @param {Record<string, string | boolean | undefined>} metaEnv — typically import.meta.env
 * @param {{ mode?: string }} runtime
 */
export function runStartupValidation(metaEnv, _runtime = {}) {
  const mode = _runtime.mode ?? (typeof import.meta !== 'undefined' ? import.meta.env?.MODE : 'development');
  let parsed;

  try {
    parsed = coerceEnv(metaEnv);
  } catch (e) {
    const msg = e?.message || String(e);
    emitConfigTelemetry(STARTUP_ERROR_CODES.ENV_PARSE, [STARTUP_ERROR_CODES.ENV_PARSE], { message: msg });
    console.error('[env] Invalid environment configuration:', msg);
    return {
      ok: false,
      parsed: null,
      errors: [msg],
      codes: [STARTUP_ERROR_CODES.ENV_PARSE],
      shouldBlockApp: false,
      userMessage: 'Environment configuration is invalid. Check VITE_* variables and rebuild.',
    };
  }

  if (usesPlaceholderCredentials(parsed)) {
    const msg = placeholderCredentialMessage();
    emitConfigTelemetry(STARTUP_ERROR_CODES.PLACEHOLDER_CREDENTIALS, [STARTUP_ERROR_CODES.PLACEHOLDER_CREDENTIALS]);
    console.error('[env]', msg);
    return {
      ok: false,
      parsed,
      errors: [msg],
      codes: [STARTUP_ERROR_CODES.PLACEHOLDER_CREDENTIALS],
      shouldBlockApp: true,
      userMessage: msg,
    };
  }

  // Fail closed if any VITE_* variable carries a known-secret name or value.
  // This is a critical defence against accidental browser-bundle leaks.
  const leakScan = scanForViteSecretLeaks(metaEnv);
  if (!leakScan.ok) {
    leakScan.errors.forEach((m) => console.error('[env]', m));
    emitConfigTelemetry(STARTUP_ERROR_CODES.VITE_SECRET_LEAK, [STARTUP_ERROR_CODES.VITE_SECRET_LEAK]);
    return {
      ok: false,
      parsed,
      errors: leakScan.errors,
      codes: [STARTUP_ERROR_CODES.VITE_SECRET_LEAK],
      shouldBlockApp: true,
      userMessage:
        'Sensitive secrets are exposed as VITE_* variables. They would be shipped to every browser. Move them to Supabase Edge Function secrets and redeploy.',
    };
  }

  const gate = requireProductionSecrets(parsed, mode);

  if (!gate.ok) {
    gate.errors.forEach((m) => console.error('[env]', m));
    emitConfigTelemetry(STARTUP_ERROR_CODES.STRICT_GATE, [STARTUP_ERROR_CODES.STRICT_GATE], {
      appEnv: parsed.VITE_APP_ENV,
    });
    console.warn(
      '[env] Supabase configuration is missing or invalid for a strict environment. Blocking app startup until env vars are configured.'
    );
    return {
      ok: false,
      parsed,
      errors: gate.errors,
      codes: [STARTUP_ERROR_CODES.STRICT_GATE],
      shouldBlockApp: true,
      userMessage:
        'Supabase configuration is missing or invalid. Set VITE_SUPABASE_URL (https URL) and VITE_SUPABASE_ANON_KEY to enable full auth and data.',
    };
  }

  return {
    ok: true,
    parsed,
    errors: gate.errors || [],
    codes: [],
    shouldBlockApp: false,
    userMessage: '',
  };
}

/**
 * Markup mounted into #root when the app cannot safely start (avoids a blank screen).
 */
export function renderStartupBlockedRootHtml(result) {
  const lines = (result.errors && result.errors.length ? result.errors : [result.userMessage]).map(escapeHtml);
  const code = result.codes?.[0] ? escapeHtml(result.codes[0]) : 'CONFIG';
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1.25rem;line-height:1.5;color:#111;background:#fafafa;min-height:100vh"><h1 style="font-size:1.25rem">Application cannot start</h1><p>${escapeHtml(result.userMessage || 'Configuration error.')}</p><p><strong>Code:</strong> <code style="color:#7c2d12">${code}</code></p><pre style="background:#fff;padding:1rem;border:1px solid #ddd;border-radius:6px;overflow:auto;font-size:.875rem;white-space:pre-wrap">${lines.join('\n')}</pre><p style="font-size:.875rem;color:#444">If you deploy on Vercel, set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in Project Settings → Environment Variables, then redeploy.</p></div>`;
}

/**
 * Legacy entry for callers that expect throw-on-failure semantics (tests, tooling).
 */
export function validateClientEnv(metaEnv, runtime = {}) {
  const mode = runtime.mode ?? import.meta.env.MODE;
  let parsed;

  try {
    parsed = coerceEnv(metaEnv);
  } catch (e) {
    console.error('[env] Invalid environment configuration:', e?.message || e);
    emitConfigTelemetry(STARTUP_ERROR_CODES.ENV_PARSE, [STARTUP_ERROR_CODES.ENV_PARSE]);
    if (mode === 'production') {
      throw e;
    }
    return { ok: false, parsed: null, errors: [String(e?.message || e)] };
  }

  if (usesPlaceholderCredentials(parsed)) {
    throw new Error(placeholderCredentialMessage());
  }

  const gate = requireProductionSecrets(parsed, mode);
  if (!gate.ok) {
    gate.errors.forEach((msg) => console.error('[env]', msg));
    emitConfigTelemetry(STARTUP_ERROR_CODES.STRICT_GATE, [STARTUP_ERROR_CODES.STRICT_GATE]);
    if (mode === 'production' || parsed.VITE_STRICT_ENV === 'true') {
      throw new Error(`[env] Missing required secrets: ${gate.errors.join('; ')}`);
    }
  }

  return { ok: true, parsed, errors: gate.errors };
}
