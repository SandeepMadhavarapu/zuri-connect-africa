import { METRICS, track } from './metrics.js';
import { log, LOG_LEVELS } from './logger.js';

let _traces = {};

export function startTrace(name) {
  const traceId = `trace_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const startedAt = performance.now();

  _traces[traceId] = { traceId, name, startedAt, endedAt: null, durationMs: null };
  return { traceId, name, startedAt };
}

export function endTrace(traceId) {
  const span = _traces[traceId];
  if (!span) return null;

  const endedAt = performance.now();
  const durationMs = Math.round(endedAt - span.startedAt);

  span.endedAt = endedAt;
  span.durationMs = durationMs;

  if (span.name.includes('transaction') || span.name.includes('payment')) {
    track(METRICS.TRANSACTION_LATENCY, durationMs, { operation: span.name });
  }

  log(LOG_LEVELS.INFO, `Trace completed: ${span.name}`, {
    traceId,
    durationMs,
    operation: span.name,
  });

  return { traceId, name: span.name, durationMs };
}
