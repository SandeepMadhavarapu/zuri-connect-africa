# Observability — Zuri Connect Africa

## Client-side structured logs

`src/lib/observability/logger.js` writes structured log entries with levels. Forward browser logs to your backend by posting `getLogs()` on a schedule (optional integration).

## Correlation IDs

- HTTP helpers in `src/api/request.js` attach `x-correlation-id` (see `securityConfig.correlationIdHeader`).
- `src/lib/observability/traceContext.js` fills the header when absent so manual `fetch` calls stay consistent.

## Metrics facade

`METRICS` in `src/lib/observability/metrics.js` defines counters for fraud, auth failures, settlement, queues, webhooks. **Mirror these names** in Datadog / Grafana / CloudWatch dashboards:

| Metric key | Suggested panel |
|------------|-----------------|
| `AUTH_FAILURE_COUNT` | Auth failures over time, breakdown by route |
| `FRAUD_TRIGGER_COUNT` | Fraud escalations |
| `QUEUE_RETRY_COUNT` | Queue retries / backoff pressure |
| `SETTLEMENT_FAILURE` | Settlement failures |
| `DEAD_LETTER_DEPTH` | DLQ depth |
| `WEBHOOK_LATENCY` | p50/p95 webhook latency |
| `RECONCILIATION_DURATION` | Reconciliation job duration |

## Distributed tracing

`tracing.js` exposes `startTrace` / `endTrace` spans for critical flows. For OpenTelemetry export, add an OTLP exporter in a non-UI worker or Edge Function and propagate `x-correlation-id` as `traceparent` where supported.

## Dashboard checklist

Create boards that join:

1. **Auth**: spike in `AUTH_FAILURE_COUNT` + Supabase Auth logs.
2. **Fraud**: `FRAUD_TRIGGER_COUNT` + manual review queue depth.
3. **Queues**: `QUEUE_RETRY_COUNT`, `DEAD_LETTER_DEPTH`, oldest message age.
4. **Settlement**: `SETTLEMENT_FAILURE`, `SETTLEMENT_LATENCY`.
5. **API**: browser Navigation Timing + Edge Function latency (Supabase dashboard).
6. **Reconciliation**: `RECONCILIATION_DURATION` + mismatch reports from reconciliation engine exports.

## API latency

Measure Edge Function RTT from the client using `performance.now()` around `invokeEdgeFunction` calls (optional wrapper); tag with correlation ID for trace stitching.
