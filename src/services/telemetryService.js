import { obs, METRICS } from '@/lib/observability';

export function trackAuthFailure(reason, meta = {}) {
  obs.track(METRICS.AUTH_FAILURE_COUNT, 1, { ...meta, reason });
}

export function trackWebhookFailure(latencyMs, meta = {}) {
  obs.track(METRICS.WEBHOOK_LATENCY, latencyMs, meta);
}

export function trackPaymentLatency(ms, meta = {}) {
  obs.track(METRICS.TRANSACTION_LATENCY, ms, meta);
}

export function trackReconciliation(durationMs, meta = {}) {
  obs.track(METRICS.RECONCILIATION_DURATION, durationMs, meta);
}
