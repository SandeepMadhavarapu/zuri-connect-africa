/**
 * Central environment configuration — validated types via envSchema.
 * Strict startup checks run in main.jsx before App is imported.
 */

import { coerceEnv } from './envSchema.js';

const parsed = coerceEnv(import.meta.env);

const _url = String(parsed.VITE_SUPABASE_URL || '').trim();
const _key = String(parsed.VITE_SUPABASE_ANON_KEY || '').trim();

const PLACEHOLDER_VALUES = [
  'https://your-project-id.supabase.co',
  'your-anon-key-here',
  'REPLACE_ME',
  '',
];

if (
  PLACEHOLDER_VALUES.includes(import.meta.env.VITE_SUPABASE_URL) ||
  PLACEHOLDER_VALUES.includes(import.meta.env.VITE_SUPABASE_ANON_KEY)
) {
  throw new Error(
    '[ZuriConnect] Supabase credentials are not configured.\n' +
      'Copy .env.example to .env.local and fill in your real Supabase URL and anon key.\n' +
      'See SETUP.md for full instructions.'
  );
}

/** True when URL and anon key meet minimum bar for real Supabase calls (matches envSchema gate). */
export const isSupabaseConfigured =
  _url.startsWith('https://') && _key.length >= 20;

export const env = {
  appEnv: parsed.VITE_APP_ENV,
  supabaseUrl: parsed.VITE_SUPABASE_URL || '',
  supabaseAnonKey: parsed.VITE_SUPABASE_ANON_KEY || '',
  apiBaseUrl: parsed.VITE_API_BASE_URL || '',
  strictEnv: parsed.VITE_STRICT_ENV === 'true',
  mode: import.meta.env.MODE,
  isDev: import.meta.env.DEV,
  isProduction: import.meta.env.PROD,
  isSupabaseConfigured,
};

export function getFunctionsBaseUrl() {
  if (!env.supabaseUrl) return '';
  return `${env.supabaseUrl.replace(/\/$/, '')}/functions/v1`;
}
