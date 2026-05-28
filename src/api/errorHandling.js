export class ApiError extends Error {
  constructor(message, { status, code, body, correlationId, retryAfterSeconds } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.correlationId = correlationId;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
  }
}

export function normalizeError(err, correlationId) {
  if (err instanceof ApiError) {
    return err;
  }
  const msg = err?.message || String(err);
  return new ApiError(msg, { correlationId });
}
