/**
 * Zuri Connect Africa — Internal Event Bus
 * Lightweight pub/sub for decoupled UI ↔ infrastructure communication.
 * Pure JS — no external dependencies, no DOM required.
 *
 * Supported events (PAYMENT_*, LEDGER_*, FRAUD_*, DEVICE_*, SESSION_*, AUTH_*):
 *   PAYMENT_CREATED, PAYMENT_SETTLED, PAYMENT_FAILED,
 *   LEDGER_POSTED, FRAUD_FLAGGED, DEVICE_UNTRUSTED,
 *   RECONCILIATION_COMPLETED, SESSION_LOCKED, AUTH_FAILED
 */

export const EVENTS = {
  PAYMENT_CREATED:          'PAYMENT_CREATED',
  PAYMENT_SETTLED:          'PAYMENT_SETTLED',
  PAYMENT_FAILED:           'PAYMENT_FAILED',
  LEDGER_POSTED:            'LEDGER_POSTED',
  FRAUD_FLAGGED:            'FRAUD_FLAGGED',
  DEVICE_UNTRUSTED:         'DEVICE_UNTRUSTED',
  RECONCILIATION_COMPLETED: 'RECONCILIATION_COMPLETED',
  SESSION_LOCKED:           'SESSION_LOCKED',
  AUTH_FAILED:              'AUTH_FAILED',
  WEBHOOK_RECEIVED:         'webhook.received',
  WEBHOOK_VERIFIED:         'webhook.verified',
  WEBHOOK_REJECTED:         'webhook.rejected',
  WEBHOOK_DUPLICATE:        'webhook.duplicate',
  WEBHOOK_DEADLETTERED:     'webhook.deadlettered',
  SETTLEMENT_UPDATED:       'settlement.updated',
  SETTLEMENT_FAILED:        'settlement.failed',
  FRAUD_CLUSTER_DETECTED:   'fraud.cluster_detected',
  RECONCILIATION_FAILED:    'reconciliation.failed',
};

// Internal registry: event → Set<handler>
const _listeners = {};

// ── Core API ───────────────────────────────────────────────────────────────────

/**
 * Emit an event with an optional payload.
 * All registered handlers are called synchronously in registration order.
 * Errors in individual handlers are caught and logged to prevent cascade failures.
 */
export function emit(event, payload = {}) {
  const handlers = _listeners[event];
  if (!handlers || handlers.size === 0) return;

  const envelope = {
    event,
    payload,
    timestamp: Date.now(),
  };

  handlers.forEach(handler => {
    try {
      handler(envelope);
    } catch (err) {
      console.error(`[EventBus] Handler error on event "${event}":`, err);
    }
  });
}

/**
 * Subscribe to an event. Returns an unsubscribe function.
 * @param {string}   event   — event name (use EVENTS.* constants)
 * @param {Function} handler — called with { event, payload, timestamp }
 * @returns {Function} unsubscribe
 */
export function on(event, handler) {
  if (!_listeners[event]) _listeners[event] = new Set();
  _listeners[event].add(handler);

  // Return cleanup function for React useEffect
  return () => off(event, handler);
}

/**
 * Unsubscribe a specific handler from an event.
 */
export function off(event, handler) {
  _listeners[event]?.delete(handler);
}

/**
 * Subscribe to an event exactly once — auto-unsubscribes after first call.
 * @returns {Function} unsubscribe (call to cancel before first emit)
 */
export function once(event, handler) {
  const wrapper = (envelope) => {
    handler(envelope);
    off(event, wrapper);
  };
  return on(event, wrapper);
}

/**
 * Remove ALL listeners for an event (or every event if none specified).
 * Useful for cleanup in tests or session resets.
 */
export function clear(event) {
  if (event) {
    delete _listeners[event];
  } else {
    Object.keys(_listeners).forEach(k => delete _listeners[k]);
  }
}

/**
 * Get the current listener count for debugging.
 * @returns {{ [event]: number }}
 */
export function listenerCounts() {
  return Object.fromEntries(
    Object.entries(_listeners).map(([k, v]) => [k, v.size])
  );
}
