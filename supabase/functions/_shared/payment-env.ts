/**
 * Zuri Connect Africa — payment runtime env helpers.
 *
 * Single source of truth for deciding which gating decisions are safe in the
 * current environment. The goal: production / staging deployments MUST refuse
 * webhook skip flags even if an operator accidentally sets them.
 *
 * Environment variables consulted (in priority order):
 *   * `DARAJA_ENV`     — 'production' | 'sandbox'  (Daraja side)
 *   * `APP_ENV`        — 'production' | 'staging' | 'sandbox' | 'demo' | 'local'
 *   * `WEBHOOK_SKIP_SIGNATURE` — 'true' to disable HMAC verification
 *   * `WEBHOOK_SKIP_IP_CHECK`  — 'true' to disable Safaricom IP allowlist
 *
 * Hard rule: skip flags can ONLY take effect when BOTH
 *   * DARAJA_ENV is NOT 'production', AND
 *   * APP_ENV is EXPLICITLY one of: 'local' | 'demo' | 'sandbox'.
 *
 * An unset / unknown APP_ENV fails closed (treated as production) even when
 * DARAJA_ENV=sandbox — see areWebhookSkipFlagsAllowed (INFO-8). Anything else
 * (production / staging / unknown high-tier env) returns `allowedHere = false`,
 * and the webhook handler must reject the request.
 */

export type AppEnv = 'production' | 'staging' | 'sandbox' | 'demo' | 'local' | 'unknown';
export type DarajaEnv = 'production' | 'sandbox' | 'unknown';

const NON_PROD_APP_ENVS: AppEnv[] = ['sandbox', 'demo', 'local'];

function readEnv(key: string): string {
  // deno-lint-ignore no-explicit-any
  const denoLike: any = (globalThis as any).Deno;
  if (denoLike?.env?.get) {
    return String(denoLike.env.get(key) ?? '').trim();
  }
  // deno-lint-ignore no-explicit-any
  const proc: any = (globalThis as any).process;
  if (proc?.env?.[key] !== undefined) {
    return String(proc.env[key] ?? '').trim();
  }
  return '';
}

export function getDarajaEnv(): DarajaEnv {
  const value = readEnv('DARAJA_ENV').toLowerCase();
  if (value === 'production') return 'production';
  if (value === 'sandbox') return 'sandbox';
  return 'unknown';
}

export function getAppEnv(): AppEnv {
  const value = readEnv('APP_ENV').toLowerCase();
  if (value === 'production') return 'production';
  if (value === 'staging')    return 'staging';
  if (value === 'sandbox')    return 'sandbox';
  if (value === 'demo')       return 'demo';
  if (value === 'local')      return 'local';
  return 'unknown';
}

/**
 * Returns true ONLY when this deployment is safe to bypass webhook crypto
 * checks. Any production / staging / unknown environment returns false.
 *
 * IMPORTANT: 'unknown' is treated as production for skip-flag purposes —
 * fail closed when env config is missing.
 */
export function areWebhookSkipFlagsAllowed(): boolean {
  const daraja = getDarajaEnv();
  if (daraja === 'production') return false;

  const app = getAppEnv();
  if (app === 'production' || app === 'staging') return false;

  // Skip flags require an EXPLICIT non-prod APP_ENV (local/demo/sandbox).
  // 'unknown' fails closed — treated as production — even when DARAJA_ENV=sandbox,
  // so a prod-like deployment with APP_ENV unset/misspelled cannot silently
  // re-enable signature/IP bypasses (INFO-8).
  return NON_PROD_APP_ENVS.includes(app);
}

export type WebhookSkipFlagState = {
  /** raw env value of WEBHOOK_SKIP_SIGNATURE === 'true' */
  skipSignatureRequested: boolean;
  /** raw env value of WEBHOOK_SKIP_IP_CHECK === 'true' */
  skipIpRequested:        boolean;
  /** true only when we are in sandbox/demo/local AND a flag was requested */
  skipSignatureEffective: boolean;
  skipIpEffective:        boolean;
  /** true if any skip flag was requested while NOT allowed (i.e. production) */
  refusedInProduction:    boolean;
  /** convenience: APP_ENV value */
  appEnv:                 AppEnv;
  /** convenience: DARAJA_ENV value */
  darajaEnv:              DarajaEnv;
};

/**
 * Resolve skip-flag state for the current request. The webhook handler should
 * reject the callback (and emit `webhook.skip_flag_refused`) whenever
 * `refusedInProduction` is true.
 */
export function resolveWebhookSkipFlags(): WebhookSkipFlagState {
  const skipSigReq  = readEnv('WEBHOOK_SKIP_SIGNATURE').toLowerCase() === 'true';
  const skipIpReq   = readEnv('WEBHOOK_SKIP_IP_CHECK').toLowerCase()   === 'true';
  const allowedHere = areWebhookSkipFlagsAllowed();
  const requested   = skipSigReq || skipIpReq;

  return {
    skipSignatureRequested: skipSigReq,
    skipIpRequested:        skipIpReq,
    skipSignatureEffective: skipSigReq && allowedHere,
    skipIpEffective:        skipIpReq  && allowedHere,
    refusedInProduction:    requested  && !allowedHere,
    appEnv:                 getAppEnv(),
    darajaEnv:              getDarajaEnv(),
  };
}

/**
 * Returns true if a Daraja "query stk push" provider call is safe to attempt
 * (i.e. all required secrets are present). Reconciliation falls back to
 * timeout / review_required when this is false.
 */
export function isDarajaQueryConfigured(): boolean {
  return Boolean(
    readEnv('DARAJA_CONSUMER_KEY') &&
    readEnv('DARAJA_CONSUMER_SECRET') &&
    readEnv('DARAJA_SHORTCODE') &&
    readEnv('DARAJA_PASSKEY'),
  );
}

/**
 * True for production-tier deployments. Mirrors the tier check in
 * function-env.ts (kept local to avoid a circular import). 'unknown' is NOT
 * production-tier here, but webhook-handler independently *requires* DARAJA_ENV
 * to be set, so any real Daraja production target trips DARAJA_ENV==='production'.
 */
function isWebhookProductionTier(): boolean {
  const app = getAppEnv();
  return app === 'production' || app === 'staging' || getDarajaEnv() === 'production';
}

// ─── MED-2: webhook authenticity config (fail-closed at init) ────────────────

export type WebhookAuthMode = 'hmac' | 'trusted_proxy' | 'unconfigured';

/**
 * Daraja does NOT sign its callbacks. A deployment declares ONE explicit
 * authenticity mode:
 *   * 'hmac'          — MPESA_WEBHOOK_SECRET (or WEBHOOK_SECRET) is set; a
 *                       fronting signing gateway injects x-mpesa-signature and
 *                       the handler verifies the HMAC.
 *   * 'trusted_proxy' — WEBHOOK_TRUSTED_SIGNING_PROXY=true explicitly asserts an
 *                       out-of-band gateway authenticates every callback before
 *                       it reaches this function (no per-function secret).
 *   * 'unconfigured'  — neither; fatal in production (see checkWebhookAuthConfig).
 */
export function resolveWebhookAuthMode(): WebhookAuthMode {
  if (readEnv('MPESA_WEBHOOK_SECRET') || readEnv('WEBHOOK_SECRET')) return 'hmac';
  if (readEnv('WEBHOOK_TRUSTED_SIGNING_PROXY').toLowerCase() === 'true') return 'trusted_proxy';
  return 'unconfigured';
}

export type WebhookAuthConfigResult =
  | { ok: true;  mode: WebhookAuthMode }
  | { ok: false; mode: 'unconfigured'; reason: 'webhook_secret_or_trusted_proxy_required' };

/**
 * Fail-closed gate for webhook authenticity CONFIG, evaluated at function init
 * (not per request). A production-tier deployment MUST have a signing secret OR
 * an explicit trusted-signing-proxy assertion; otherwise it would boot into a
 * state where every genuine (unsigned) Daraja callback is rejected 401
 * missing_signature and no payment ever settles (MED-2). "IP allowlist only,
 * no secret" is NOT a supported production mode. Sandbox/local/demo are
 * unconstrained here (skip flags cover them).
 */
export function checkWebhookAuthConfig(): WebhookAuthConfigResult {
  const mode = resolveWebhookAuthMode();
  if (!isWebhookProductionTier()) return { ok: true, mode };
  if (mode === 'unconfigured') {
    return { ok: false, mode, reason: 'webhook_secret_or_trusted_proxy_required' };
  }
  return { ok: true, mode };
}

// ─── MED-1: trusted client-IP source (fail-closed at init) ───────────────────

/**
 * Number of trusted proxy hops that front this function, declared via
 * WEBHOOK_TRUSTED_PROXY_DEPTH. The real client IP is read as the Nth entry from
 * the RIGHT of X-Forwarded-For (appended by the trusted chain), never the
 * leftmost (client-controlled) value. Returns null when unset/invalid.
 */
export function getWebhookTrustedProxyDepth(): number | null {
  const raw = readEnv('WEBHOOK_TRUSTED_PROXY_DEPTH');
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 ? n : null;
}

export type WebhookIpTrustConfigResult =
  | { ok: true;  depth: number | null }
  | { ok: false; reason: 'trusted_proxy_depth_required' };

/**
 * Fail-closed gate for the trusted client-IP SOURCE (MED-1). The Safaricom IP
 * allowlist is only meaningful if the client IP is read from a position in the
 * X-Forwarded-For chain that the caller cannot control. Operators declare how
 * many trusted proxy hops front this function via WEBHOOK_TRUSTED_PROXY_DEPTH.
 * In production this MUST be a positive integer; otherwise the leftmost
 * (spoofable) entry could be trusted, so we fail closed at init.
 */
export function checkWebhookIpTrustConfig(): WebhookIpTrustConfigResult {
  const depth = getWebhookTrustedProxyDepth();
  if (!isWebhookProductionTier()) return { ok: true, depth };
  if (depth === null) return { ok: false, reason: 'trusted_proxy_depth_required' };
  return { ok: true, depth };
}

/**
 * Resolve the client IP from the TRUSTED position in the X-Forwarded-For chain.
 * With a declared `depth` (trusted proxy hops), the real client is the Nth entry
 * from the right — the value appended by the trusted chain, not the leftmost
 * client-supplied entry (MED-1). A chain shorter than `depth` cannot be trusted
 * and resolves to 'unknown' (the IP allowlist then rejects it). Without a
 * declared depth (non-production only), falls back to x-real-ip, never the
 * leftmost X-Forwarded-For value.
 */
export function resolveTrustedClientIp(
  xForwardedFor: string | null,
  xRealIp: string | null,
  depth: number | null,
): string {
  const parts = (xForwardedFor || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (depth !== null && depth >= 1) {
    return parts.length >= depth ? parts[parts.length - depth] : 'unknown';
  }
  return (xRealIp || '').trim() || 'unknown';
}
