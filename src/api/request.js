import { securityConfig } from '@/config/securityConfig.js';
import { mergeTraceHeaders } from '@/lib/observability/traceContext.js';
import { ApiError } from './errorHandling.js';

function newCorrelationId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `cid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function parseRetryAfter(header, body) {
  const fromBody = Number(
    body?.retryAfterSeconds ??
    body?.retry_after_seconds ??
    body?.retry_after,
  );
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.round(fromBody);
  if (!header) return null;
  const asNumber = Number(header);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.round(asNumber);
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    const delta = Math.round((asDate - Date.now()) / 1000);
    return delta > 0 ? delta : null;
  }
  return null;
}

/**
 * Structured fetch with timeout, correlation ID, and JSON defaults.
 */
export async function request(url, options = {}) {
  const correlationId = options.correlationId || newCorrelationId();
  const timeoutMs = options.timeoutMs ?? securityConfig.defaultRequestTimeoutMs;
  const headers = mergeTraceHeaders({
    'Content-Type': 'application/json',
    [securityConfig.correlationIdHeader]: correlationId,
    ...options.headers,
  });

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer =
    controller &&
    setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller?.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      // Capture Retry-After when present so callers (rate-limit UX) can
      // surface a precise wait time instead of guessing. Accepts both the
      // numeric-seconds and HTTP-date forms; falls back to body fields.
      const retryAfterHeader = res.headers?.get?.('Retry-After');
      const retryAfterSeconds = parseRetryAfter(retryAfterHeader, body);
      throw new ApiError(body?.error || res.statusText || 'Request failed', {
        status: res.status,
        body,
        correlationId,
        retryAfterSeconds,
      });
    }
    return { data: body, correlationId, status: res.status };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
