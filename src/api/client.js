import { env } from '@/config/env.js';
import { endpoints } from './endpoints.js';
import { request } from './request.js';
import { withBackoff } from './retry.js';
import { ApiError } from './errorHandling.js';

const EDGE_NAMES = {
  sendOTP: 'sendOtp',
  verifyOTP: 'verifyOtp',
  webhookHandler: 'webhookHandler',
  reconciliationJob: 'reconciliationJob',
  settlementRecovery: 'settlementRecovery',
  aiRouter: 'aiRouter',
  notificationDispatcher: 'notificationDispatcher',
  initiatePayment: 'initiatePayment',
  completeStepUp: 'completeStepUp',
  setPin: 'setPin',
};

// Default retry policy for Edge calls: only retry on transient 5xx, NEVER on
// 429. Retrying a 429 burns provider quota and makes rate limits worse.
// Callers can override via the `retry` option (e.g. AI sets retries:0).
const DEFAULT_RETRY = {
  retries: 2,
  shouldRetry: (err) =>
    err instanceof ApiError && err.status >= 500 && err.status < 600,
};

/**
 * Invoke a Supabase Edge Function by logical name (stable ids mapped in EDGE_NAMES).
 *
 * @param {string} functionId          Logical edge id (e.g. 'aiRouter', 'sendOTP').
 * @param {object} [payload]           JSON body.
 * @param {string|null} [accessToken]  User access token; falls back to anon key.
 * @param {object} [options]
 * @param {{retries?:number, shouldRetry?:Function}} [options.retry]
 *   Per-call retry policy. Pass `{ retries: 0 }` to disable retries entirely.
 */
export async function invokeEdgeFunction(functionId, payload = {}, accessToken = null, options = {}) {
  const key = EDGE_NAMES[functionId] || functionId;
  const urlFn = endpoints[key];
  if (typeof urlFn !== 'function') {
    throw new ApiError(`Unknown edge function: ${functionId}`);
  }
  const url = urlFn();
  if (!env.supabaseUrl || !env.supabaseAnonKey) {
    throw new ApiError('Supabase environment not configured');
  }

  const authHeader = accessToken
    ? `Bearer ${accessToken}`
    : `Bearer ${env.supabaseAnonKey}`;

  const run = () =>
    request(url, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
      headers: {
        apikey: env.supabaseAnonKey,
        Authorization: authHeader,
      },
      timeoutMs: 60000,
    });

  const retryPolicy = { ...DEFAULT_RETRY, ...(options.retry || {}) };
  const { data } = await withBackoff(run, retryPolicy);

  return data;
}
