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
 *   * APP_ENV is one of: 'local' | 'demo' | 'sandbox' | (unset for tests)
 *
 * Anything else (production / staging / unknown high-tier env) returns
 * `allowedHere = false`, and the webhook handler must reject the request.
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

  // Sandbox / demo / local are explicit opt-ins.
  if (daraja === 'sandbox') return true;
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
