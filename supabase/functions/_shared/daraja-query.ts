/**
 * Zuri Connect Africa — Daraja STK Query (transaction status) helper.
 *
 * Reconciliation needs a way to ask Daraja "what happened to this STK push?"
 * for payments that are stuck in `waiting_for_mpesa` / `processing`. This
 * module provides the network call AND a normaliser that maps Daraja's wire
 * format into a small, server-controlled enum:
 *
 *     succeeded | failed | cancelled | timeout | still_pending |
 *     provider_unknown | provider_error
 *
 * The caller (reconciliation-job, admin-reconciliation) decides what to do
 * with the normalised result. This file deliberately does NOT touch the
 * ledger, the pending_payments table, or any other privileged state.
 *
 * Production safety rules enforced here:
 *
 *   1. Sandbox URL is used unless `DARAJA_ENV=production`.
 *   2. The OAuth token, base64 password, raw Authorization header, passkey,
 *      consumer secret, and raw Daraja response body are NEVER logged. The
 *      only thing that ever reaches console.error is a sanitized summary
 *      (status code + truncated `ResponseDescription`).
 *   3. `result_desc` returned to callers is truncated + stripped of control
 *      characters so it cannot poison logs or be surfaced verbatim to users.
 *   4. The raw provider payload is hashed (SHA-256) so reconciliation events
 *      can store proof-of-receipt without leaking PII.
 *
 * The pure functions (`darajaQueryBaseUrl`, `buildStkQueryRequestBody`,
 * `normalizeStkQueryResponse`, `sanitizeResultDesc`, `hashRawPayload`) are
 * unit-tested directly from vitest. The network call (`queryStkPush`) is
 * tested via dependency injection of `fetchImpl`.
 */

// deno-lint-ignore-file no-explicit-any

import {
  darajaBaseUrl,
  generateDarajaPassword,
  generateDarajaTimestamp,
  getDarajaToken,
} from './daraja-stk.ts';

// ── Provider status enum ─────────────────────────────────────────────────

export type ProviderQueryOutcome =
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'still_pending'
  | 'provider_unknown'
  | 'provider_error';

export interface NormalizedStkQuery {
  outcome:               ProviderQueryOutcome;
  checkoutRequestId:     string;
  merchantRequestId:     string | null;
  resultCode:            string;
  /** Truncated, control-char-stripped, max 240 chars. */
  resultDesc:            string;
  /** Daraja STK Query has no receipt field; populated only if the caller
   *  later confirms via a callback. Kept here so the type is stable. */
  providerReceipt:       string | null;
  /** Verbatim Daraja `ResultCode -> outcome` mapping label. */
  providerStatus:        ProviderQueryOutcome;
  /** SHA-256 of the original Daraja JSON body, hex. Never the body itself. */
  rawPayloadHash:        string;
  queriedAt:             string;
}

// ── Daraja STK Query result-code mapping ─────────────────────────────────
//
// Reference: https://developer.safaricom.co.ke/Documentation
//
//   "0"    – Transaction successful
//   "1037" – DS timeout user cannot be reached
//   "1025" – Internal error
//   "1032" – Request cancelled by user
//   "1001" – Unable to lock subscriber
//   "1019" – Transaction has expired
//   "1"    – Insufficient funds
//   "2001" – Wrong PIN entered
//   "500.001.1001" – Subscribed to STK Push limit
//   ""     – Request still pending (Daraja sometimes returns ResultCode null)
//
// Anything we don't recognise becomes `provider_unknown` so reconciliation
// errs on the side of manual review.

const TIMEOUT_CODES   = new Set(['1037', '1019', '500.001.1019']);
const CANCEL_CODES    = new Set(['1032']);
const PENDING_CODES   = new Set(['1', '1037', '1001']); // Note: some pending overlaps with timeout; we resolve below.
const SUCCESS_CODES   = new Set(['0']);
const KNOWN_FAILURE_PHRASES = [
  'failed', 'reject', 'invalid', 'incorrect', 'wrong pin',
  'insufficient', 'unable', 'subscriber', 'expired',
];

/**
 * Map a Daraja STK Query response `ResultCode` + `ResultDesc` to the
 * normalised enum. Defaults to `provider_unknown` for anything we do not
 * recognise — callers must treat that as "do not touch ledger".
 */
export function mapStkQueryOutcome(resultCode: string, resultDescRaw: string): ProviderQueryOutcome {
  const code = String(resultCode ?? '').trim();
  const desc = String(resultDescRaw ?? '').toLowerCase();

  if (SUCCESS_CODES.has(code)) return 'succeeded';
  if (CANCEL_CODES.has(code))  return 'cancelled';
  if (TIMEOUT_CODES.has(code) || desc.includes('timeout') || desc.includes('timed out')) {
    return 'timeout';
  }

  // Daraja sometimes returns code "1" for genuine failures (insufficient
  // funds) and sometimes for "still being processed". Use the description
  // to disambiguate. We match "processing" / "processed" / "pending"
  // tolerantly because the live Daraja docs are inconsistent.
  const looksPending =
    desc.includes('processing') || desc.includes('processed') || desc.includes('pending');
  if (code === '1' && looksPending) {
    return 'still_pending';
  }
  if (PENDING_CODES.has(code) && looksPending) {
    return 'still_pending';
  }

  if (KNOWN_FAILURE_PHRASES.some((p) => desc.includes(p))) return 'failed';

  if (code === '' || code === 'null' || code === 'undefined') return 'still_pending';

  return 'provider_unknown';
}

/**
 * Strip control characters, collapse whitespace, truncate to 240 chars. This
 * is what the caller persists / shows in the ops dashboard.
 */
export function sanitizeResultDesc(raw: unknown): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
}

/**
 * SHA-256 hex of any JSON-stringifyable payload.
 */
export async function hashRawPayload(payload: unknown): Promise<string> {
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

// ── URL gating ───────────────────────────────────────────────────────────

/**
 * Base URL for STK Query. Identical host as STK Push but the path
 * differs (/mpesa/stkpushquery/v1/query). We delegate to `darajaBaseUrl`
 * so production lives at api.safaricom.co.ke and everything else
 * (sandbox/local/demo/unknown) at sandbox.safaricom.co.ke.
 */
export function darajaQueryBaseUrl(darajaEnv: string): string {
  return darajaBaseUrl(String(darajaEnv ?? '').toLowerCase());
}

// ── Request body builder ─────────────────────────────────────────────────

export type StkQueryRequest = {
  BusinessShortCode: string;
  Password:          string;
  Timestamp:         string;
  CheckoutRequestID: string;
};

export function buildStkQueryRequestBody({
  shortcode,
  passkey,
  checkoutRequestId,
  timestamp,
}: {
  shortcode:          string;
  passkey:            string;
  checkoutRequestId:  string;
  timestamp?:         string;
}): StkQueryRequest {
  const ts = (timestamp && /^\d{14}$/.test(timestamp))
    ? timestamp
    : generateDarajaTimestamp();
  return {
    BusinessShortCode: shortcode,
    Password:          generateDarajaPassword(shortcode, passkey, ts),
    Timestamp:         ts,
    CheckoutRequestID: checkoutRequestId,
  };
}

// ── Network call (DI-friendly) ───────────────────────────────────────────

export type StkQueryDeps = {
  /** Override clock to stabilise test timestamps. */
  now?: () => string;
  /** Inject fetch for testing. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Inject token fetcher for testing. */
  getToken?:  (consumerKey: string, consumerSecret: string, baseUrl: string) => Promise<string>;
};

export type StkQueryInput = {
  darajaEnv:          string;
  consumerKey:        string;
  consumerSecret:     string;
  shortcode:          string;
  passkey:            string;
  checkoutRequestId:  string;
  merchantRequestId?: string | null;
};

/**
 * Perform the actual Daraja STK Query and return a normalised result.
 *
 * Never throws on network/Daraja errors — those collapse to
 * `provider_error` so the caller can decide on review_required vs retry.
 */
export async function queryStkPush(input: StkQueryInput, deps: StkQueryDeps = {}): Promise<NormalizedStkQuery> {
  const queriedAt = deps.now?.() ?? new Date().toISOString();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const tokenFetcher = deps.getToken ?? getDarajaToken;
  const baseUrl = darajaQueryBaseUrl(input.darajaEnv);

  // Default response when we can't even start the query.
  const errorResult = (resultDesc: string, outcome: ProviderQueryOutcome): NormalizedStkQuery => ({
    outcome,
    checkoutRequestId: input.checkoutRequestId,
    merchantRequestId: input.merchantRequestId ?? null,
    resultCode:        '',
    resultDesc:        sanitizeResultDesc(resultDesc),
    providerReceipt:   null,
    providerStatus:    outcome,
    rawPayloadHash:    '',
    queriedAt,
  });

  if (!input.consumerKey || !input.consumerSecret || !input.shortcode || !input.passkey) {
    return errorResult('daraja_secrets_missing', 'provider_error');
  }
  if (!input.checkoutRequestId) {
    return errorResult('missing_checkout_request_id', 'provider_error');
  }

  let token: string;
  try {
    token = await tokenFetcher(input.consumerKey, input.consumerSecret, baseUrl);
  } catch (e) {
    console.error('[daraja-query] oauth fetch failed', { status: (e as Error)?.name });
    return errorResult('daraja_oauth_failed', 'provider_error');
  }

  const body = buildStkQueryRequestBody({
    shortcode:         input.shortcode,
    passkey:           input.passkey,
    checkoutRequestId: input.checkoutRequestId,
  });

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/mpesa/stkpushquery/v1/query`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error('[daraja-query] network error', { name: (e as Error)?.name });
    return errorResult('daraja_network_error', 'provider_error');
  }

  // Daraja returns 200 with a JSON body containing ResultCode/ResultDesc
  // for both success and most failure modes; non-200 responses are typically
  // auth / structural failures and should NOT be parsed as the canonical
  // payment status.
  let data: Record<string, any> = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }
  const rawPayloadHash = await hashRawPayload(data);

  if (!res.ok) {
    // Daraja returns HTTP 500 with errorMessage="The transaction is being
    // processed" for genuinely pending pushes — treat that explicitly.
    const errMsg = sanitizeResultDesc(data.errorMessage ?? data.ResponseDescription ?? `http_${res.status}`);
    const lower  = errMsg.toLowerCase();
    if (lower.includes('processing') || lower.includes('pending') || lower.includes('being processed')) {
      return {
        outcome:           'still_pending',
        providerStatus:    'still_pending',
        checkoutRequestId: input.checkoutRequestId,
        merchantRequestId: input.merchantRequestId ?? null,
        resultCode:        '',
        resultDesc:        errMsg,
        providerReceipt:   null,
        rawPayloadHash,
        queriedAt,
      };
    }
    console.error('[daraja-query] non-ok response', { status: res.status });
    return {
      outcome:           'provider_error',
      providerStatus:    'provider_error',
      checkoutRequestId: input.checkoutRequestId,
      merchantRequestId: input.merchantRequestId ?? null,
      resultCode:        '',
      resultDesc:        errMsg,
      providerReceipt:   null,
      rawPayloadHash,
      queriedAt,
    };
  }

  const resultCode = String(data.ResultCode ?? data.resultCode ?? '');
  const resultDesc = sanitizeResultDesc(data.ResultDesc ?? data.resultDesc ?? '');
  const outcome    = mapStkQueryOutcome(resultCode, resultDesc);
  const merchantRequestId = data.MerchantRequestID
    ? String(data.MerchantRequestID)
    : (input.merchantRequestId ?? null);

  return {
    outcome,
    providerStatus:    outcome,
    checkoutRequestId: String(data.CheckoutRequestID ?? input.checkoutRequestId),
    merchantRequestId,
    resultCode,
    resultDesc,
    providerReceipt:   null, // STK Query never returns the M-PESA receipt.
    rawPayloadHash,
    queriedAt,
  };
}

// ── Convenience: read env + run ──────────────────────────────────────────

/**
 * Build the STK Query input from `Deno.env`. Returns null if Daraja query
 * secrets aren't fully configured (caller should fall back to review).
 *
 * IMPORTANT: this is intentionally a small helper and not exported as the
 * default entry point because admin-reconciliation needs to log + audit
 * "secrets missing" attempts.
 */
export function readStkQueryEnv(
  checkoutRequestId: string,
  merchantRequestId: string | null = null,
): StkQueryInput | null {
  // deno-lint-ignore no-explicit-any
  const denoLike: any = (globalThis as any).Deno;
  // deno-lint-ignore no-explicit-any
  const proc: any = (globalThis as any).process;
  const read = (k: string): string => {
    if (denoLike?.env?.get) return String(denoLike.env.get(k) ?? '');
    if (proc?.env?.[k] !== undefined) return String(proc.env[k] ?? '');
    return '';
  };

  const consumerKey    = read('DARAJA_CONSUMER_KEY');
  const consumerSecret = read('DARAJA_CONSUMER_SECRET');
  const shortcode      = read('DARAJA_SHORTCODE');
  const passkey        = read('DARAJA_PASSKEY');
  const darajaEnv      = read('DARAJA_ENV');

  if (!consumerKey || !consumerSecret || !shortcode || !passkey) return null;

  return {
    darajaEnv,
    consumerKey,
    consumerSecret,
    shortcode,
    passkey,
    checkoutRequestId,
    merchantRequestId,
  };
}
