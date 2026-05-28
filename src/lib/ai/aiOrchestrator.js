/**
 * AI orchestrator facade + circuit breaker observability.
 * Cloud providers wrap edge calls with withBreaker (see ./providers/*).
 * Core routing remains in ./orchestrator.js (uses ./failover.js).
 */

import { getStats as getBreakerStats } from './circuitBreaker.js';

export { routeAIRequest, getObservabilityLog } from './orchestrator.js';

export function getAIProviderStats() {
  return getBreakerStats();
}
