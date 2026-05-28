import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import {
  scanForViteSecretLeaks,
  requireProductionSecrets,
  FORBIDDEN_VITE_KEYS,
  APP_ENV_VALUES,
} from '../../src/config/envSchema.js';

import {
  runStartupValidation,
  STARTUP_ERROR_CODES,
} from '../../src/config/validateEnv.js';

import { computeClientDemoPolicy } from '../../src/config/clientSecurityPolicy.js';

import {
  requireFunctionEnv,
} from '../../supabase/functions/_shared/function-env.ts';

const ROOT = process.cwd();

const ENV_KEYS = [
  'APP_ENV', 'DARAJA_ENV', 'APP_ORIGIN',
  'AT_USERNAME', 'AT_API_KEY',
  'OTP_PEPPER', 'PIN_PEPPER',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_NAME',
  'DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET',
  'DARAJA_SHORTCODE', 'DARAJA_PASSKEY', 'DARAJA_CALLBACK_URL',
  'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'MPESA_WEBHOOK_SECRET', 'WEBHOOK_SECRET',
  'WEBHOOK_SKIP_SIGNATURE', 'WEBHOOK_SKIP_IP_CHECK',
];

function snap() {
  const s = {};
  for (const k of ENV_KEYS) s[k] = process.env[k];
  return s;
}
function restore(s) {
  for (const k of ENV_KEYS) {
    if (s[k] === undefined) delete process.env[k];
    else                    process.env[k] = s[k];
  }
}

describe('frontend strict env gate', () => {
  it('production rejects missing VITE_SUPABASE_URL via requireProductionSecrets', () => {
    const r = requireProductionSecrets(
      { VITE_APP_ENV: 'production', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: 'a'.repeat(30), VITE_STRICT_ENV: 'true' },
      'production',
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/VITE_SUPABASE_URL/);
  });

  it('production rejects missing VITE_STRICT_ENV=true', () => {
    const r = requireProductionSecrets(
      { VITE_APP_ENV: 'production', VITE_SUPABASE_URL: 'https://ok.supabase.co', VITE_SUPABASE_ANON_KEY: 'a'.repeat(30), VITE_STRICT_ENV: 'false' },
      'production',
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/VITE_STRICT_ENV must be "true"/);
  });

  it('production rejects VITE_ALLOW_CLIENT_DEMO_CONTROLS=true', () => {
    const r = requireProductionSecrets(
      {
        VITE_APP_ENV: 'production',
        VITE_SUPABASE_URL: 'https://ok.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'a'.repeat(30),
        VITE_STRICT_ENV: 'true',
        VITE_ALLOW_CLIENT_DEMO_CONTROLS: 'true',
      },
      'production',
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/VITE_ALLOW_CLIENT_DEMO_CONTROLS/);
  });

  it('local dev does not require strict flags', () => {
    const r = requireProductionSecrets(
      { VITE_APP_ENV: 'local', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
      'development',
    );
    expect(r.ok).toBe(true);
  });

  it('production requires anon OR publishable key', () => {
    const r = requireProductionSecrets(
      { VITE_APP_ENV: 'production', VITE_SUPABASE_URL: 'https://ok.supabase.co', VITE_SUPABASE_ANON_KEY: '', VITE_STRICT_ENV: 'true' },
      'production',
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/VITE_SUPABASE_ANON_KEY/);
  });

  it('runtime startup blocks strict production/staging env failures', () => {
    const r = runStartupValidation(
      {
        VITE_APP_ENV: 'production',
        VITE_SUPABASE_URL: 'https://ok.supabase.co',
        VITE_SUPABASE_ANON_KEY: 'a'.repeat(30),
        VITE_STRICT_ENV: 'false',
      },
      { mode: 'production' },
    );
    expect(r.ok).toBe(false);
    expect(r.shouldBlockApp).toBe(true);
    expect(r.codes).toContain(STARTUP_ERROR_CODES.STRICT_GATE);
  });
});

describe('VITE_* secret leakage scan', () => {
  it('exports the forbidden list', () => {
    expect(FORBIDDEN_VITE_KEYS).toContain('VITE_SUPABASE_SERVICE_ROLE_KEY');
    expect(FORBIDDEN_VITE_KEYS).toContain('VITE_DARAJA_CONSUMER_SECRET');
    expect(FORBIDDEN_VITE_KEYS).toContain('VITE_OTP_PEPPER');
    expect(FORBIDDEN_VITE_KEYS).toContain('VITE_PIN_PEPPER');
    expect(FORBIDDEN_VITE_KEYS).toContain('VITE_GEMINI_API_KEY');
    expect(FORBIDDEN_VITE_KEYS).toContain('VITE_OPENAI_API_KEY');
    expect(FORBIDDEN_VITE_KEYS).toContain('VITE_MPESA_WEBHOOK_SECRET');
  });

  it('flags VITE_SUPABASE_SERVICE_ROLE_KEY when present', () => {
    const r = scanForViteSecretLeaks({ VITE_SUPABASE_SERVICE_ROLE_KEY: 'eyJabc.def.ghi' });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/VITE_SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('flags Daraja secrets exposed as VITE_*', () => {
    const r = scanForViteSecretLeaks({ VITE_DARAJA_CONSUMER_SECRET: 'somesecret' });
    expect(r.ok).toBe(false);
  });

  it('flags AI provider keys exposed as VITE_*', () => {
    expect(scanForViteSecretLeaks({ VITE_GEMINI_API_KEY: 'AIzaSyExample' }).ok).toBe(false);
    expect(scanForViteSecretLeaks({ VITE_OPENAI_API_KEY: 'sk-Example' }).ok).toBe(false);
    expect(scanForViteSecretLeaks({ VITE_ANTHROPIC_API_KEY: 'sk-ant-Example' }).ok).toBe(false);
  });

  it('flags VITE_ vars with secret-looking names', () => {
    expect(scanForViteSecretLeaks({ VITE_SOMETHING_SECRET: 'x' }).ok).toBe(false);
    expect(scanForViteSecretLeaks({ VITE_FOO_PEPPER: 'x' }).ok).toBe(false);
    expect(scanForViteSecretLeaks({ VITE_BAR_API_KEY: 'x' }).ok).toBe(false);
  });

  it('flags VITE_ vars with secret-looking JWT values', () => {
    const jwt = 'eyJabcdefghij.abcdefghij.abcdefghij';
    const r = scanForViteSecretLeaks({ VITE_SOMETHING_RANDOM: jwt });
    expect(r.ok).toBe(false);
  });

  it('passes when only allowlisted VITE_ vars are present', () => {
    const r = scanForViteSecretLeaks({
      VITE_SUPABASE_URL: 'https://ok.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'eyJ_long_anon_key_string_x_long_long_long.payload.signature',
      VITE_APP_ENV: 'production',
      VITE_STRICT_ENV: 'true',
    });
    expect(r.ok).toBe(true);
  });
});

describe('client demo policy gate', () => {
  it('production refuses demo controls', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'production',
      strictEnv: true,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
      isProductionBundle: true,
    });
    expect(p.allowBrowserDemoControls).toBe(false);
    expect(p.allowBiometricClientSimulation).toBe(false);
    expect(p.allowAnonymousDemoFinancials).toBe(false);
    expect(p.hardenedSurface).toBe(true);
  });

  it('staging refuses demo controls', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'staging',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
      isProductionBundle: false,
    });
    expect(p.hardenedSurface).toBe(true);
  });

  it('unknown appEnv fails closed (no demo)', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'unknown',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
      isProductionBundle: false,
    });
    expect(p.hardenedSurface).toBe(true);
    expect(p.allowBrowserDemoControls).toBe(false);
  });

  it('allows demo when APP_ENV=local + VITE_ALLOW_CLIENT_DEMO_CONTROLS=true + !strict', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'local',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
      isProductionBundle: false,
    });
    expect(p.hardenedSurface).toBe(false);
    expect(p.allowBrowserDemoControls).toBe(true);
  });

  it('allows demo when APP_ENV=demo + VITE_ALLOW_CLIENT_DEMO_CONTROLS=true + !strict', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'demo',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
      isProductionBundle: false,
    });
    expect(p.hardenedSurface).toBe(false);
  });

  it('APP_ENV enum includes demo and local', () => {
    expect(APP_ENV_VALUES).toContain('demo');
    expect(APP_ENV_VALUES).toContain('local');
  });
});

describe('Edge Function env validator', () => {
  let s;
  beforeEach(() => {
    s = snap();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restore(s));

  it('fails closed in production when required secrets are missing', () => {
    process.env.APP_ENV = 'production';
    const r = requireFunctionEnv({
      functionName: 'send-otp',
      required: ['APP_ORIGIN', 'AT_USERNAME', 'AT_API_KEY', 'OTP_PEPPER'],
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(['APP_ORIGIN', 'AT_USERNAME', 'AT_API_KEY', 'OTP_PEPPER']));
  });

  it('fails closed in staging when required secrets are missing', () => {
    process.env.APP_ENV = 'staging';
    const r = requireFunctionEnv({
      functionName: 'verify-otp',
      required: ['APP_ORIGIN', 'OTP_PEPPER'],
    });
    expect(r.ok).toBe(false);
  });

  it('fails closed when DARAJA_ENV=production even if APP_ENV unset', () => {
    process.env.DARAJA_ENV = 'production';
    const r = requireFunctionEnv({
      functionName: 'initiate-payment',
      required: ['DARAJA_CONSUMER_KEY'],
    });
    expect(r.ok).toBe(false);
  });

  it('warns but allows in sandbox when secrets are missing', () => {
    process.env.DARAJA_ENV = 'sandbox';
    process.env.APP_ENV = 'local';
    const r = requireFunctionEnv({
      functionName: 'send-otp',
      required: ['APP_ORIGIN', 'OTP_PEPPER'],
    });
    expect(r.ok).toBe(true);
  });

  it('always-required keys fail closed even in sandbox', () => {
    process.env.APP_ENV = 'local';
    const r = requireFunctionEnv({
      functionName: 'send-otp',
      required: [],
      alwaysRequired: ['SUPABASE_URL'],
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('SUPABASE_URL');
  });

  it('passes when all required secrets are set', () => {
    process.env.APP_ENV = 'production';
    process.env.APP_ORIGIN = 'https://app.example.com';
    process.env.OTP_PEPPER = 'a'.repeat(64);
    process.env.AT_USERNAME = 'u';
    process.env.AT_API_KEY = 'k';
    process.env.SUPABASE_URL = 'https://ok.supabase.co';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'svc';
    const r = requireFunctionEnv({
      functionName: 'send-otp',
      required:       ['APP_ORIGIN', 'AT_USERNAME', 'AT_API_KEY', 'OTP_PEPPER'],
      alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    });
    expect(r.ok).toBe(true);
  });
});

describe('Edge Function CORS: no wildcard in sensitive functions', () => {
  const sensitive = [
    'send-otp', 'verify-otp', 'set-pin', 'complete-step-up',
    'verify-biometric', 'ai-router', 'initiate-payment', 'webhook-handler',
    'reconciliation-job', 'settlement-recovery',
    'notification-dispatcher',
  ];
  for (const fn of sensitive) {
    it(`${fn} does not use wildcard CORS`, () => {
      const file = join(ROOT, 'supabase', 'functions', fn, 'index.ts');
      if (!existsSync(file)) return; // function not present in this build
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/'Access-Control-Allow-Origin'\s*:\s*['"]\*['"]/);
    });
  }

  it('each sensitive function falls back to "null" (APP_ORIGIN missing fails closed in browsers)', () => {
    for (const fn of sensitive) {
      const file = join(ROOT, 'supabase', 'functions', fn, 'index.ts');
      if (!existsSync(file)) continue;
      const text = readFileSync(file, 'utf8');
      // Either explicit "null" fallback OR APP_ORIGIN-only with no wildcard.
      const hasNullFallback = /APP_ORIGIN\s*\|\|\s*['"]null['"]/.test(text);
      const hasNoWildcard   = !/'Access-Control-Allow-Origin'\s*:\s*['"]\*['"]/.test(text);
      expect(hasNullFallback && hasNoWildcard).toBe(true);
    }
  });
});

describe('CSP headers (vercel.json + nginx.conf)', () => {
  it('vercel.json connect-src restricts to self + supabase', () => {
    const v = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    const csp = v.headers[0].headers.find((h) => h.key === 'Content-Security-Policy');
    expect(csp).toBeDefined();
    expect(csp.value).toMatch(/connect-src 'self' https:\/\/\*\.supabase\.co/);
    // Browser must not be allowed to call AI providers directly.
    expect(csp.value).not.toMatch(/api\.openai\.com/);
    expect(csp.value).not.toMatch(/anthropic\.com/);
    expect(csp.value).not.toMatch(/generativelanguage\.googleapis\.com/);
    // frame-ancestors must remain in headers (works only via HTTP CSP).
    expect(csp.value).toMatch(/frame-ancestors 'none'/);
  });

  it('nginx.conf CSP restricts connect-src and blocks AI providers', () => {
    const ng = readFileSync(join(ROOT, 'nginx.conf'), 'utf8');
    expect(ng).toMatch(/Content-Security-Policy/);
    expect(ng).toMatch(/connect-src 'self' https:\/\/\*\.supabase\.co/);
    expect(ng).not.toMatch(/api\.openai\.com/);
    expect(ng).not.toMatch(/anthropic\.com/);
  });

  it('index.html does not declare frame-ancestors via meta (must be header-only)', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).not.toMatch(/frame-ancestors/);
  });

  it('manifest.json and favicon.svg exist and are linked from index.html', () => {
    const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
    expect(html).toMatch(/manifest\.json/);
    expect(html).toMatch(/favicon\.svg/);
    expect(existsSync(join(ROOT, 'public', 'manifest.json'))).toBe(true);
    expect(existsSync(join(ROOT, 'public', 'favicon.svg'))).toBe(true);
  });
});

describe('packaging: .gitignore + SETUP.md', () => {
  it('.gitignore ignores .env, .env.local, .env.*.local, node_modules, dist, supabase/.temp', () => {
    const gi = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const entry of ['.env', '.env.local', '.env.*.local', 'node_modules', 'dist', 'supabase/.temp']) {
      expect(gi).toContain(entry);
    }
  });

  it('SETUP.md mentions the packaging checklist items', () => {
    const setup = readFileSync(join(ROOT, 'SETUP.md'), 'utf8');
    expect(setup).toMatch(/\.env\.local/);
    expect(setup).toMatch(/node_modules/);
    expect(setup).toMatch(/\bdist\b/);
    expect(setup).toMatch(/secrets/i);
    expect(setup).toMatch(/VITE_STRICT_ENV/);
    expect(setup).toMatch(/WEBHOOK_SKIP_SIGNATURE/);
  });

  it('package.json exposes the prepitch script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.prepitch).toBeTruthy();
    expect(pkg.scripts.prepitch).toMatch(/check:prepitch|check-prepitch/);
    expect(pkg.scripts['check:prepitch']).toMatch(/check-prepitch\.mjs/);
  });

  it('check-prepitch script exists', () => {
    expect(existsSync(join(ROOT, 'scripts', 'check-prepitch.mjs'))).toBe(true);
  });
});
