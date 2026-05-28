/**
 * Per-provider circuit breaker for AI orchestration.
 * Three states:
 *   - CLOSED      → normal operation, all requests pass through
 *   - OPEN        → recent failures exceeded threshold, all requests fail fast
 *   - HALF_OPEN   → cooldown elapsed, allow ONE probe request to test recovery
 *
 * Default config:
 *   failureThreshold     = 5     (consecutive failures to trip)
 *   cooldownMs           = 60000 (60s open → half-open)
 *   probeTimeoutMs       = 8000  (per-request hard timeout)
 *   successesToClose     = 2     (half-open successes needed to fully close)
 *
 * Stats per breaker are exposed via getStats() for observability dashboards.
 */

const STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

const DEFAULTS = Object.freeze({
  failureThreshold: 5,
  cooldownMs: 60_000,
  probeTimeoutMs: 8_000,
  successesToClose: 2,
});

const breakers = new Map();

export class CircuitBreakerOpenError extends Error {
  constructor(name, retryInMs) {
    super(`Circuit breaker OPEN for provider "${name}". Retry in ${retryInMs}ms.`);
    this.name = 'CircuitBreakerOpenError';
    this.provider = name;
    this.retryInMs = retryInMs;
  }
}

export class CircuitBreakerTimeoutError extends Error {
  constructor(name, ms) {
    super(`Provider "${name}" timed out after ${ms}ms`);
    this.name = 'CircuitBreakerTimeoutError';
    this.provider = name;
    this.timeoutMs = ms;
  }
}

function getOrCreate(name, config) {
  let b = breakers.get(name);
  if (!b) {
    b = {
      name,
      state: STATE.CLOSED,
      consecutiveFailures: 0,
      halfOpenSuccesses: 0,
      openedAt: 0,
      lastFailureAt: 0,
      totalRequests: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      totalShortCircuited: 0,
      totalTimeouts: 0,
      config: { ...DEFAULTS, ...(config || {}) },
    };
    breakers.set(name, b);
  }
  return b;
}

function shouldHalfOpen(b) {
  if (b.state !== STATE.OPEN) return false;
  return Date.now() - b.openedAt >= b.config.cooldownMs;
}

function trip(b) {
  b.state = STATE.OPEN;
  b.openedAt = Date.now();
  b.halfOpenSuccesses = 0;
  console.warn(`[CircuitBreaker] OPEN ${b.name} after ${b.consecutiveFailures} failures`);
}

function close(b) {
  if (b.state === STATE.CLOSED) return;
  b.state = STATE.CLOSED;
  b.consecutiveFailures = 0;
  b.halfOpenSuccesses = 0;
  console.info(`[CircuitBreaker] CLOSED ${b.name}`);
}

function halfOpen(b) {
  b.state = STATE.HALF_OPEN;
  b.halfOpenSuccesses = 0;
  console.info(`[CircuitBreaker] HALF_OPEN ${b.name}`);
}

function recordSuccess(b) {
  b.totalSuccesses += 1;
  b.consecutiveFailures = 0;
  if (b.state === STATE.HALF_OPEN) {
    b.halfOpenSuccesses += 1;
    if (b.halfOpenSuccesses >= b.config.successesToClose) close(b);
  }
}

function recordFailure(b) {
  b.totalFailures += 1;
  b.lastFailureAt = Date.now();
  b.consecutiveFailures += 1;
  if (b.state === STATE.HALF_OPEN) {
    trip(b);
    return;
  }
  if (b.consecutiveFailures >= b.config.failureThreshold) trip(b);
}

async function withTimeout(name, ms, fn) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CircuitBreakerTimeoutError(name, ms)), ms);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute a function under circuit breaker protection.
 * Throws CircuitBreakerOpenError if breaker is open.
 * Throws CircuitBreakerTimeoutError if probeTimeoutMs is exceeded.
 * Propagates the underlying error otherwise.
 */
export async function withBreaker(name, fn, config) {
  const b = getOrCreate(name, config);
  b.totalRequests += 1;

  if (b.state === STATE.OPEN) {
    if (shouldHalfOpen(b)) {
      halfOpen(b);
    } else {
      b.totalShortCircuited += 1;
      const retryInMs = b.config.cooldownMs - (Date.now() - b.openedAt);
      throw new CircuitBreakerOpenError(name, Math.max(retryInMs, 0));
    }
  }

  try {
    const result = await withTimeout(name, b.config.probeTimeoutMs, fn);
    recordSuccess(b);
    return result;
  } catch (err) {
    if (err instanceof CircuitBreakerTimeoutError) b.totalTimeouts += 1;
    recordFailure(b);
    throw err;
  }
}

export function getStats(name) {
  if (name) {
    const b = breakers.get(name);
    if (!b) return null;
    return snapshot(b);
  }
  return Array.from(breakers.values()).map(snapshot);
}

function snapshot(b) {
  return {
    name: b.name,
    state: b.state,
    consecutiveFailures: b.consecutiveFailures,
    totalRequests: b.totalRequests,
    totalFailures: b.totalFailures,
    totalSuccesses: b.totalSuccesses,
    totalShortCircuited: b.totalShortCircuited,
    totalTimeouts: b.totalTimeouts,
    successRate: b.totalRequests > 0
      ? Math.round((b.totalSuccesses / b.totalRequests) * 100)
      : 0,
    openedAt: b.openedAt || null,
    config: { ...b.config },
  };
}

export function reset(name) {
  if (name) {
    const b = breakers.get(name);
    if (b) {
      b.state = STATE.CLOSED;
      b.consecutiveFailures = 0;
      b.halfOpenSuccesses = 0;
      b.openedAt = 0;
    }
  } else {
    breakers.forEach((b) => {
      b.state = STATE.CLOSED;
      b.consecutiveFailures = 0;
      b.halfOpenSuccesses = 0;
      b.openedAt = 0;
    });
  }
}

export const BREAKER_STATE = STATE;
