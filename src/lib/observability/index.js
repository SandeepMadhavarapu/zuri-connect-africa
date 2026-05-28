/**
 * Zuri Connect Africa — Structured Observability (facade)
 */

export { METRICS, track, getMetrics, resetMetrics } from './metrics.js';
export { LOG_LEVELS, log, getLogs } from './logger.js';
export { startTrace, endTrace } from './tracing.js';
export { getCorrelationId, setCorrelationId, mergeTraceHeaders } from './traceContext.js';

import { METRICS, track, getMetrics } from './metrics.js';
import { LOG_LEVELS, log } from './logger.js';
import { startTrace, endTrace } from './tracing.js';

export const obs = {
  info: (msg, meta) => log(LOG_LEVELS.INFO, msg, meta),
  warn: (msg, meta) => log(LOG_LEVELS.WARN, msg, meta),
  error: (msg, meta) => log(LOG_LEVELS.ERROR, msg, meta),
  critical: (msg, meta) => log(LOG_LEVELS.CRITICAL, msg, meta),
  track,
  startTrace,
  endTrace,
  getMetrics,
};
