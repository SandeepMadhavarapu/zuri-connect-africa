/**
 * Client-side security tuning — keys and secrets never belong here.
 */

export const securityConfig = {
  sessionRefreshLeadSeconds: 60,
  maxWebhookReplayWindowSeconds: 300,
  correlationIdHeader: 'x-correlation-id',
  defaultRequestTimeoutMs: 30000,
  aiRequestTimeoutMs: 45000,
};
