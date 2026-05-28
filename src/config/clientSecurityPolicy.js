/**
 * Client-side security / demo isolation policy.
 *
 * Trust boundary: browser storage and simulated UX must never stand in for
 * real auth or risk decisions on staging/production (or when strict env is on).
 */

import { env } from './env.js';

/**
 * Pure predicate for tests and future server-driven policy sync.
 * @param {{ appEnv: string, strictEnv: boolean, isViteDev: boolean, allowClientDemoControlsFlag: boolean, isProductionBundle?: boolean }} input
 */
export function computeClientDemoPolicy(input) {
  const {
    appEnv,
    strictEnv,
    isViteDev,
    allowClientDemoControlsFlag,
    isProductionBundle = false,
  } = input;

  const tierHardened =
    strictEnv === true ||
    appEnv === 'staging' ||
    appEnv === 'production';

  /** Any non–dev-server bundle defaults safe unless explicitly opted in (e.g. internal preview demos). */
  const productionBundleWithoutDemoOptIn =
    isProductionBundle === true && allowClientDemoControlsFlag !== true;

  const hardenedSurface = tierHardened || productionBundleWithoutDemoOptIn;

  if (hardenedSurface) {
    return {
      hardenedSurface: true,
      allowBrowserDemoControls: false,
      allowBiometricClientSimulation: false,
      allowAnonymousDemoFinancials: false,
      allowDefaultDemoPin: false,
    };
  }

  // Defence in depth: even when not tier-hardened, relaxed surface requires
  // an explicit non-production app env. This blocks the "appEnv was somehow
  // missing or set to 'unknown'" regression path.
  const appEnvAllowsDemo =
    appEnv === 'local' ||
    appEnv === 'demo' ||
    appEnv === 'development';

  if (!appEnvAllowsDemo) {
    return {
      hardenedSurface: true,
      allowBrowserDemoControls: false,
      allowBiometricClientSimulation: false,
      allowAnonymousDemoFinancials: false,
      allowDefaultDemoPin: false,
    };
  }

  const relaxed =
    isViteDev === true || allowClientDemoControlsFlag === true;

  return {
    hardenedSurface: false,
    allowBrowserDemoControls: relaxed,
    allowBiometricClientSimulation: relaxed,
    allowAnonymousDemoFinancials: relaxed,
    allowDefaultDemoPin: relaxed,
  };
}

/** Resolved policy for the running bundle (call at use time, not module top-level in tests). */
export function getClientDemoPolicy() {
  return computeClientDemoPolicy({
    appEnv: env.appEnv,
    strictEnv: env.strictEnv,
    isViteDev: import.meta.env.DEV,
    allowClientDemoControlsFlag: import.meta.env.VITE_ALLOW_CLIENT_DEMO_CONTROLS === 'true',
    isProductionBundle: import.meta.env.PROD,
  });
}
