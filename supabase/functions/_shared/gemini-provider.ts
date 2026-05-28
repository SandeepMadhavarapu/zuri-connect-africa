/**
 * Zuri Connect Africa — Gemini provider helpers (server-side only).
 *
 * This module is intentionally small, side-effect-free, and testable. It is
 * imported by `ai-router/index.ts` and by vitest tests; it must never:
 *
 *   - run in the browser (CSP blocks direct Gemini calls),
 *   - log the API key, raw request body, full provider response, or
 *     Authorization headers,
 *   - return raw provider error messages to the caller.
 *
 * Public surface:
 *
 *   GEMINI_DEFAULT_MODEL       — current safe default text model.
 *   GEMINI_API_VERSION         — Gemini REST API version we target.
 *   GEMINI_MODEL_FALLBACK_CHAIN — internal failover chain on 404.
 *   resolveGeminiModel(env)    — pick the model from env / fallback.
 *   buildGeminiEndpoint(model, apiKey) — generateContent URL.
 *   parseGeminiText(data)      — extract joined text from a Gemini response.
 *   callGemini(prompt, opts)   — single-shot call (throws AIProviderError).
 *   callGeminiWithModelFailover(prompt, opts) — retries on 404 down the chain.
 */

import {
  AIProviderError,
  parseRetryAfterHeader,
  publicCodeForStatus,
  type AIProviderPublicCode,
} from './ai-provider-errors.ts';

export const GEMINI_DEFAULT_MODEL = 'gemini-2.0-flash';
export const GEMINI_API_VERSION = 'v1beta';
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com';

/**
 * Ordered list of Gemini text models we try when the configured/default
 * model returns 404. Newer first so live keys upgrade automatically; the
 * deprecated 1.5 entry is kept only as a last-ditch attempt for old keys.
 */
export const GEMINI_MODEL_FALLBACK_CHAIN: readonly string[] = [
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',
  'gemini-1.5-flash',
];

const GEMINI_PROVIDER = 'gemini';

export type GeminiEnv = Record<string, string | undefined> | undefined;

export function resolveGeminiModel(env?: GeminiEnv): string {
  const raw = (env?.GEMINI_MODEL ?? '').trim();
  return raw || GEMINI_DEFAULT_MODEL;
}

export function buildGeminiEndpoint(model: string, apiKey: string): string {
  // The API key is sent as a query string parameter per Google's docs.
  // We URL-encode it defensively, but never log or surface the resulting URL
  // because it embeds the secret.
  const safeModel = encodeURIComponent(model);
  return `${GEMINI_API_BASE}/${GEMINI_API_VERSION}/models/${safeModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

/**
 * Extract a single user-facing text string from a Gemini response.
 *
 *   - Handles `candidates[0].content.parts[0].text`.
 *   - Joins multiple text parts safely.
 *   - Returns '' when candidates / parts / text are missing.
 *
 * Never throws — the caller decides how to surface emptiness.
 */
export function parseGeminiText(data: unknown): string {
  const candidates = (data as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) return '';
  const first = candidates[0] as { content?: { parts?: unknown } } | undefined;
  const parts = first?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => {
      const t = (p as { text?: unknown })?.text;
      return typeof t === 'string' ? t : '';
    })
    .filter((t) => t.length > 0)
    .join('');
}

export type GeminiFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CallGeminiOptions {
  apiKey: string;
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: GeminiFetch;
  /** Optional generation overrides; defaults are conservative. */
  temperature?: number;
  maxOutputTokens?: number;
}

function geminiRequestBody(prompt: string, opts: CallGeminiOptions): string {
  return JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.2,
      maxOutputTokens: opts.maxOutputTokens ?? 1024,
    },
  });
}

/**
 * One-shot Gemini call. Throws AIProviderError on any failure mode so the
 * router can map provider problems to public codes without leaking secrets
 * or raw provider payloads.
 */
export async function callGemini(prompt: string, opts: CallGeminiOptions): Promise<string> {
  const model = (opts.model ?? '').trim() || GEMINI_DEFAULT_MODEL;
  const fetcher = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetcher(buildGeminiEndpoint(model, opts.apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: geminiRequestBody(prompt, opts),
      signal: opts.signal,
    });
  } catch {
    throw new AIProviderError(GEMINI_PROVIDER, model, 504, 'AI_PROVIDER_TIMEOUT');
  }

  if (!res.ok) {
    const publicCode: AIProviderPublicCode = publicCodeForStatus(res.status);
    // Capture Retry-After before draining the body so a 429 can propagate
    // a precise wait time to the browser without exposing the raw payload.
    const retryAfterSeconds = res.status === 429
      ? parseRetryAfterHeader(res.headers?.get?.('Retry-After'))
      : undefined;
    try { await res.text(); } catch { /* noop */ }
    const detail = res.status === 404 ? 'model_not_found' as const : undefined;
    throw new AIProviderError(
      GEMINI_PROVIDER,
      model,
      res.status,
      publicCode,
      detail,
      retryAfterSeconds ?? undefined,
    );
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AIProviderError(GEMINI_PROVIDER, model, 502, 'AI_PROVIDER_BAD_RESPONSE', 'malformed_response');
  }

  const candidates = (data as { candidates?: unknown })?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new AIProviderError(GEMINI_PROVIDER, model, 502, 'AI_PROVIDER_BAD_RESPONSE', 'empty_candidates');
  }

  const text = parseGeminiText(data);
  if (!text.trim()) {
    throw new AIProviderError(GEMINI_PROVIDER, model, 502, 'AI_PROVIDER_BAD_RESPONSE', 'malformed_response');
  }
  return text;
}

/**
 * Call Gemini; if the configured / default model returns 404, attempt the
 * remaining models in GEMINI_MODEL_FALLBACK_CHAIN. All other errors propagate
 * immediately. Returns `{ text, model }` so callers can report which model
 * actually answered.
 */
export async function callGeminiWithModelFailover(
  prompt: string,
  opts: CallGeminiOptions,
): Promise<{ text: string; model: string }> {
  const primary = (opts.model ?? '').trim() || GEMINI_DEFAULT_MODEL;
  const tried = new Set<string>();
  const chain: string[] = [primary, ...GEMINI_MODEL_FALLBACK_CHAIN].filter((m) => {
    if (!m) return false;
    if (tried.has(m)) return false;
    tried.add(m);
    return true;
  });

  let lastError: AIProviderError | null = null;
  for (const model of chain) {
    try {
      const text = await callGemini(prompt, { ...opts, model });
      return { text, model };
    } catch (err) {
      if (err instanceof AIProviderError && err.publicCode === 'AI_PROVIDER_MODEL_NOT_FOUND') {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new AIProviderError(GEMINI_PROVIDER, primary, 404, 'AI_PROVIDER_MODEL_NOT_FOUND', 'model_not_found');
}
