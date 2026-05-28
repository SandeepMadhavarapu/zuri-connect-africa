import { invokeEdgeFunction } from '@/api/client.js';
import { ApiError } from '@/api/errorHandling.js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

const INVALID_TOKEN_VALUES = new Set(['undefined', 'null', 'invalid_token', '']);

const AI_RATE_LIMIT_CODES = new Set(['rate_limited', 'AI_PROVIDER_RATE_LIMITED']);

function aiAuthError(code) {
  const error = new ApiError(code, { status: 401, code, body: { error: code, code } });
  error.code = code;
  return error;
}

function isUsableAccessToken(token) {
  const value = String(token || '').trim();
  return value.length > 20 && !INVALID_TOKEN_VALUES.has(value.toLowerCase());
}

export async function getAIAuthToken() {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase.auth.getSession();
  if (error) throw aiAuthError('AI_AUTH_INVALID');
  const token = data?.session?.access_token;
  if (!token) throw aiAuthError('AI_AUTH_REQUIRED');
  if (!isUsableAccessToken(token)) throw aiAuthError('AI_AUTH_INVALID');
  return token;
}

/**
 * Promote rate-limit responses to a single, predictable error shape so the
 * orchestrator / UI can render one polished message without inspecting both
 * `error` and `code` fields. Preserves retryAfterSeconds when supplied.
 */
function normalizeRateLimitError(err) {
  if (!(err instanceof ApiError)) return err;
  const bodyCode = err.body?.code || err.body?.error;
  const code = err.code || bodyCode;
  if (!AI_RATE_LIMIT_CODES.has(code) && err.status !== 429) return err;
  const retryAfterSeconds =
    err.retryAfterSeconds ??
    Number(err.body?.retryAfterSeconds ?? err.body?.retry_after_seconds ?? err.body?.retry_after) ??
    null;
  const normalized = new ApiError('AI_PROVIDER_RATE_LIMITED', {
    status: 429,
    code: 'AI_PROVIDER_RATE_LIMITED',
    body: err.body,
    correlationId: err.correlationId,
    retryAfterSeconds:
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds
        : undefined,
  });
  normalized.cause = err;
  return normalized;
}

// ─── In-flight request dedupe ────────────────────────────────────────────────
// One user message → one ai-router request. If the user mashes the send
// button (or React renders fire `send` twice for one keystroke) we return the
// already-in-flight promise instead of opening a second Edge call. The map
// key is the exact (prompt + schema + model) tuple; a different message
// proceeds in parallel as expected.

const inFlight = new Map();

function dedupeKey({ prompt, response_json_schema: schema, model }) {
  // Keep keys short and free of PII — we only need them to dedupe a literal
  // duplicate. The full prompt is fine here because it never leaves the
  // browser.
  return JSON.stringify({ prompt: String(prompt ?? '').slice(0, 4000), schema: schema ?? null, model: model ?? null });
}

export async function invokeLlm({ prompt, response_json_schema: schema, model }) {
  const key = dedupeKey({ prompt, response_json_schema: schema, model });
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const accessToken = await getAIAuthToken();
    try {
      const raw = await invokeEdgeFunction(
        'aiRouter',
        { prompt, response_json_schema: schema, model: model ?? 'gemini' },
        accessToken,
        // ai-router has its own server-side provider failover. Retrying from
        // the browser only multiplies rate-limit and quota burn, so disable
        // network-level retries here. Rate-limit (429) MUST not be retried.
        { retry: { retries: 0 } },
      );
      if (raw && typeof raw === 'object') {
        if (!schema && 'type' in raw && 'message' in raw) {
          return raw;
        }
        if ('parsed' in raw && raw.parsed !== undefined) {
          return raw.parsed;
        }
        if ('text' in raw && raw.text !== undefined) {
          return raw.text;
        }
      }
      return raw;
    } catch (err) {
      throw normalizeRateLimitError(err);
    }
  })();

  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

/** Test-only helper to flush the in-flight cache between cases. */
export function _resetAiInFlightForTest() {
  inFlight.clear();
}
