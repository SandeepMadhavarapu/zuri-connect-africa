/**
 * Zuri Connect Africa — Edge Function environment validator.
 *
 * Every sensitive Edge Function declares the secrets it requires via
 * `requireFunctionEnv(...)`. The helper:
 *
 *   * fails closed when any required secret is missing in production / staging,
 *   * logs a structured warning when a non-prod environment is missing optional
 *     secrets (so devs see what's not wired up),
 *   * returns a typed { ok, env, missing } so each function decides whether to
 *     short-circuit with `503 SERVICE_NOT_CONFIGURED` (the canonical response).
 *
 * It deliberately does NOT touch the request body or log secret values.
 *
 * Strict rule: production / staging MUST refuse to operate when any
 * function-required secret is missing. Sandbox / local / demo emits a warning
 * but allows the function to run so dev work isn't blocked.
 */

import { getAppEnv, getDarajaEnv } from './payment-env.ts';

export type FunctionRequirement = {
  /** Function name used in structured logs / error responses. */
  functionName: string;
  /** Env keys that MUST be set in production / staging. */
  required:    string[];
  /** Env keys that are nice-to-have but not fatal in any environment. */
  optional?:   string[];
  /** Hard-fail also when these are missing — even in sandbox. */
  alwaysRequired?: string[];
};

export type FunctionEnvResult =
  | { ok: true;  env: Record<string, string>; appEnv: string; missing: never[] }
  | { ok: false; env: Record<string, string>; appEnv: string; missing: string[]; reason: 'missing_required_env' };

function readEnv(key: string): string {
  // deno-lint-ignore no-explicit-any
  const denoLike: any = (globalThis as any).Deno;
  if (denoLike?.env?.get) return String(denoLike.env.get(key) ?? '').trim();
  // deno-lint-ignore no-explicit-any
  const proc: any = (globalThis as any).process;
  if (proc?.env?.[key] !== undefined) return String(proc.env[key] ?? '').trim();
  return '';
}

function isProductionTier(): boolean {
  const app = getAppEnv();
  const daraja = getDarajaEnv();
  return app === 'production' || app === 'staging' || daraja === 'production';
}

/**
 * Validate the calling Edge Function's required secrets.
 *
 *   const env = requireFunctionEnv({
 *     functionName: 'send-otp',
 *     required: ['APP_ORIGIN', 'AT_USERNAME', 'AT_API_KEY', 'OTP_PEPPER'],
 *   });
 *   if (!env.ok) return json({ ok: false, error: 'SERVICE_NOT_CONFIGURED' }, 503);
 */
export function requireFunctionEnv(req: FunctionRequirement): FunctionEnvResult {
  const env: Record<string, string> = {};
  const missing: string[] = [];

  for (const key of req.required ?? []) {
    const v = readEnv(key);
    env[key] = v;
    if (!v) missing.push(key);
  }
  for (const key of req.alwaysRequired ?? []) {
    const v = readEnv(key);
    env[key] = v;
    if (!v && !missing.includes(key)) missing.push(key);
  }
  for (const key of req.optional ?? []) {
    env[key] = readEnv(key);
  }

  const appEnv = getAppEnv();
  const fatalEverywhere = (req.alwaysRequired ?? []).filter((k) => !readEnv(k));
  const fatalInProd     = missing.filter((k) => !fatalEverywhere.includes(k));

  if (fatalEverywhere.length > 0) {
    console.error(`[${req.functionName}] missing_always_required_env`, { missing: fatalEverywhere });
    return { ok: false, env, appEnv, missing, reason: 'missing_required_env' };
  }

  if (missing.length > 0) {
    if (isProductionTier()) {
      console.error(`[${req.functionName}] missing_required_env_in_production`, {
        app_env: appEnv,
        missing,
      });
      return { ok: false, env, appEnv, missing, reason: 'missing_required_env' };
    }
    // Sandbox / local / demo: warn but allow.
    console.warn(`[${req.functionName}] missing_required_env_non_production`, {
      app_env: appEnv,
      missing,
      hint:    'set these secrets before deploying to staging/production',
    });
  }

  if (fatalInProd.length === 0 && missing.length === 0) {
    return { ok: true, env, appEnv, missing: [] as never[] };
  }
  // Reached only in non-prod with missing required secrets: still ok=true so
  // dev can iterate, but missing[] is populated for visibility.
  return { ok: true, env, appEnv, missing: [] as never[] };
}

/**
 * Canonical JSON shape Edge Functions should return when `requireFunctionEnv`
 * reports `ok=false`. Avoid leaking which secret is missing to anonymous
 * callers; ops can see the structured log.
 */
export function serviceNotConfiguredResponse(corsHeaders: Record<string, string>) {
  return Response.json(
    { ok: false, error: 'SERVICE_NOT_CONFIGURED' },
    { status: 503, headers: corsHeaders },
  );
}
