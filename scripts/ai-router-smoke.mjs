#!/usr/bin/env node
/**
 * Zuri Connect Africa — ai-router smoke test.
 *
 * Prints a short, secret-free diagnostic summary so a deployer can confirm
 * that the AI provider is reachable end-to-end through the Edge Function.
 *
 * Output fields (never any API key, prompt body, or raw provider payload):
 *   - provider:           which provider we asked the router to use
 *   - configured:         "true" | "false"   (any provider key visible to env)
 *   - model:              configured Gemini model (env GEMINI_MODEL or default)
 *   - status:             HTTP status from ai-router
 *   - code:               public error code (or "ok")
 *
 * Safe to run from CI. Refuses to attempt the request if Supabase URL or anon
 * key are missing.
 */

const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const accessToken = process.env.AI_ROUTER_ACCESS_TOKEN || anonKey;

const provider = (process.env.AI_ROUTER_SMOKE_PROVIDER || 'gemini').toLowerCase();
const model = (process.env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;

const providerConfigured = Boolean(
  process.env.GEMINI_API_KEY ||
  process.env.OPENAI_API_KEY ||
  process.env.ANTHROPIC_API_KEY,
);

function print(result) {
  console.log(`provider: ${provider}`);
  console.log(`configured: ${providerConfigured ? 'true' : 'false'}`);
  console.log(`model: ${model}`);
  console.log(`status: ${result.status || 'unknown'}`);
  console.log(`code: ${result.code || 'ok'}`);
}

if (!supabaseUrl || !anonKey) {
  print({ code: 'AI_ROUTER_ENV_MISSING', status: 'not_run' });
  process.exit(0);
}

try {
  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/functions/v1/ai-router`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ prompt: 'User: hello', model: provider }),
  });
  const body = await res.json().catch(() => ({}));
  print({ code: body?.code || body?.error || 'ok', status: res.status });
} catch {
  print({ code: 'AI_PROVIDER_UNAVAILABLE', status: 'fetch_failed' });
}
