/**
 * Exponential backoff with jitter for resilient Edge/API calls.
 */

export async function withBackoff(fn, {
  retries = 3,
  baseMs = 400,
  maxMs = 8000,
  shouldRetry = () => true,
} = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !shouldRetry(err, attempt)) throw err;
      const delay = Math.min(maxMs, baseMs * 2 ** attempt + Math.random() * 200);
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
    }
  }
  throw lastErr;
}
