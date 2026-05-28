/**
 * Zuri Connect Africa — AI Failover Engine (single-shot).
 *
 * One user message → one ai-router request.
 *
 * The browser MUST NOT:
 *   - cycle through openai / gemini / anthropic by calling ai-router multiple
 *     times for the same user message, or
 *   - call OpenAI / Gemini / Anthropic directly (CSP blocks it anyway and
 *     would leak provider keys).
 *
 * Provider selection and per-provider failover live SERVER-SIDE in the
 * ai-router Edge Function. The browser only tells the server which provider
 * it would prefer via the `model` hint; the server picks the actual provider,
 * applies its safety policy, and decides whether to fail over to a different
 * provider.
 *
 * The only client-side fallback is the local deterministic provider, used
 * EXACTLY ONCE when ai-router returns a non-auth, non-rate-limit error
 * (e.g. transient 5xx, model not found). On rate-limit and auth errors we
 * never call any further provider — those are surfaced as polished user
 * messages immediately.
 */

import { generateResponse as openai }    from './providers/openaiProvider';
import { generateResponse as gemini }    from './providers/geminiProvider';
import { generateResponse as anthropic } from './providers/anthropicProvider';
import { generateResponse as local }     from './providers/localFallbackProvider';

const FAILURE_LOG_KEY = 'zuri_ai_failover_log';

// Codes that must short-circuit the chain. We never retry, never call local
// fallback, and never spin through other providers when we see these.
const AUTH_ERROR_CODES = new Set(['AI_AUTH_REQUIRED', 'AI_AUTH_INVALID']);
const RATE_LIMIT_CODES = new Set(['AI_PROVIDER_RATE_LIMITED', 'rate_limited']);

// Thin server-backed provider stubs. Each one makes ONE ai-router call with
// its own `model` hint; the server then picks the actual provider. We keep
// the per-name stubs because Duke AI's observability/badges report the
// preferred provider, but we never iterate over them client-side.
const SERVER_BACKED_PROVIDERS = {
  openai,
  anthropic,
  gemini,
};

function errorCode(error) {
  return error?.code || error?.body?.code || error?.body?.error || error?.message;
}

function errorRetryAfterSeconds(error) {
  const candidates = [
    error?.retryAfterSeconds,
    error?.body?.retryAfterSeconds,
    error?.body?.retry_after_seconds,
    error?.body?.retry_after,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return null;
}

function logFailure(provider, error) {
  try {
    const log = JSON.parse(sessionStorage.getItem(FAILURE_LOG_KEY) || '[]');
    log.push({ provider, error: errorCode(error) || 'unknown', ts: Date.now() });
    sessionStorage.setItem(FAILURE_LOG_KEY, JSON.stringify(log.slice(-20)));
  } catch {}
  // eslint-disable-next-line no-console
  console.warn(`[AIFailover] Provider "${provider}" failed:`, errorCode(error) || error?.message);
}

/**
 * Single-shot AI call.
 *
 *   - Sends `payload` (plus the preferred provider as the model hint) to
 *     ai-router EXACTLY ONCE.
 *   - On auth failure → returns the canonical auth message with no retry.
 *   - On rate limit → returns once with `rateLimited: true` (and any
 *     `retryAfterSeconds` from the server); never retries, never calls the
 *     local fallback (the user-facing copy is enough).
 *   - On any other failure → calls the local deterministic provider EXACTLY
 *     ONCE so the user still sees a helpful contextual response.
 *
 * Returned shape: { response, provider, latency, fallbackTriggered,
 *                   error?, code?, authError?, rateLimited?, retryAfterSeconds? }
 */
export async function withFailover(payload, preferredProvider = 'openai') {
  const start = Date.now();
  const providerFn = SERVER_BACKED_PROVIDERS[preferredProvider] || openai;
  const providerName = SERVER_BACKED_PROVIDERS[preferredProvider]
    ? preferredProvider
    : 'openai';

  try {
    const response = await providerFn(payload);
    return {
      response,
      provider: providerName,
      latency: Date.now() - start,
      fallbackTriggered: false,
    };
  } catch (err) {
    const code = errorCode(err);
    logFailure(providerName, err);

    // 1. Auth failure — stop immediately. Do not call other providers and do
    //    not call local fallback. The user needs to sign in again.
    if (AUTH_ERROR_CODES.has(code)) {
      return {
        response: 'Please sign in again so Duke AI can respond securely.',
        provider: 'auth',
        latency: Date.now() - start,
        fallbackTriggered: false,
        error: true,
        authError: true,
        code,
      };
    }

    // 2. Rate limit — stop immediately. NEVER retry. Surface polished copy
    //    plus any server-supplied retry window so the UI can show it.
    if (RATE_LIMIT_CODES.has(code)) {
      return {
        response: 'Duke AI is cooling down for a moment. Try again shortly.',
        provider: 'rate_limited',
        latency: Date.now() - start,
        fallbackTriggered: false,
        error: true,
        rateLimited: true,
        retryAfterSeconds: errorRetryAfterSeconds(err),
        code,
      };
    }

    // 3. Everything else — run the local deterministic provider EXACTLY ONCE
    //    using the safe app-side context already built by the orchestrator.
    try {
      const localResponse = await local(payload);
      return {
        response: localResponse,
        provider: 'local',
        latency: Date.now() - start,
        fallbackTriggered: true,
        error: true,
        code,
      };
    } catch (localErr) {
      logFailure('local', localErr);
      return {
        response:
          "I'm having trouble connecting right now. Please check your internet connection or try again in a moment.",
        provider: 'local',
        latency: Date.now() - start,
        fallbackTriggered: true,
        error: true,
        code,
      };
    }
  }
}

export function getFailoverLog() {
  try { return JSON.parse(sessionStorage.getItem(FAILURE_LOG_KEY) || '[]'); } catch { return []; }
}
