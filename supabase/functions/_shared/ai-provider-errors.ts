export type AIProviderPublicCode =
  | 'AI_PROVIDER_NOT_CONFIGURED'
  | 'AI_PROVIDER_AUTH_FAILED'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_PROVIDER_TIMEOUT'
  | 'AI_PROVIDER_BAD_RESPONSE'
  | 'AI_PROVIDER_MODEL_NOT_FOUND'
  | 'AI_PROVIDER_UNAVAILABLE';

export type AIProviderErrorDetail = 'model_not_found' | 'empty_candidates' | 'malformed_response';

export class AIProviderError extends Error {
  publicCode: AIProviderPublicCode;
  status: number;
  provider: string;
  model: string;
  detail?: AIProviderErrorDetail;
  retryAfterSeconds?: number;

  constructor(
    provider: string,
    model: string,
    status: number,
    publicCode: AIProviderPublicCode,
    detail?: AIProviderErrorDetail,
    retryAfterSeconds?: number,
  ) {
    super(publicCode);
    this.name = 'AIProviderError';
    this.provider = provider;
    this.model = model;
    this.status = status;
    this.publicCode = publicCode;
    this.detail = detail;
    if (
      typeof retryAfterSeconds === 'number' &&
      Number.isFinite(retryAfterSeconds) &&
      retryAfterSeconds > 0
    ) {
      this.retryAfterSeconds = Math.round(retryAfterSeconds);
    }
  }
}

/**
 * Parse an HTTP `Retry-After` header value. Accepts both seconds-as-integer
 * and HTTP-date forms. Returns a positive integer or null.
 */
export function parseRetryAfterHeader(value: string | null | undefined): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber > 0) return Math.round(asNumber);
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) {
    const delta = Math.round((asDate - Date.now()) / 1000);
    return delta > 0 ? delta : null;
  }
  return null;
}

// Stable mapping of upstream HTTP status to a public, secret-free error code.
// 404 is mapped to AI_PROVIDER_MODEL_NOT_FOUND so a deprecated/renamed model
// (e.g. Gemini removing legacy model aliases) surfaces a clear diagnostic
// instead of a generic "bad response" code.
export function publicCodeForStatus(status: number): AIProviderPublicCode {
  if (status === 401 || status === 403) return 'AI_PROVIDER_AUTH_FAILED';
  if (status === 404) return 'AI_PROVIDER_MODEL_NOT_FOUND';
  if (status === 429) return 'AI_PROVIDER_RATE_LIMITED';
  if (status === 408 || status === 504) return 'AI_PROVIDER_TIMEOUT';
  if (status >= 500) return 'AI_PROVIDER_UNAVAILABLE';
  return 'AI_PROVIDER_BAD_RESPONSE';
}
