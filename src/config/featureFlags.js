/**
 * Feature flags — toggle capabilities without redeploying UI.
 */
import { env } from './env.js';

export const featureFlags = {
  aiInsightsEnabled: env.isDev || true,
  realtimeLedger: false,
  edgeWebhookProcessing: true,
  biometricStepUp: true,
};
