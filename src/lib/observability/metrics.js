const METRICS_KEY = 'zuri_metrics';

export const METRICS = {
  STARTUP_CONFIG_FAILURE: 'startup_config_failure',
  CSP_VIOLATION: 'csp_violation',
  DEMO_FALLBACK_BOOT: 'demo_fallback_boot',
  SUPABASE_CLIENT_INIT_MS: 'supabase_client_init_ms',
  SUPABASE_SESSION_FAILURE: 'supabase_session_failure',
  SUPABASE_REALTIME_FAILURE: 'supabase_realtime_failure',
  TRANSACTION_LATENCY: 'transaction_latency',
  FRAUD_TRIGGER_COUNT: 'fraud_trigger_count',
  AUTH_FAILURE_COUNT: 'auth_failure_count',
  QUEUE_RETRY_COUNT: 'queue_retry_count',
  SETTLEMENT_FAILURE: 'settlement_failure_count',
  LEDGER_POST_COUNT: 'ledger_post_count',
  LEDGER_PERSIST_FAILURE: 'ledger_persist_failure',
  LEDGER_DUPLICATE_PREVENTED: 'ledger_duplicate_prevented',
  LEDGER_RECON_MISMATCH: 'ledger_recon_mismatch',
  LEDGER_STALE_READ_DETECTED: 'ledger_stale_read_detected',
  LEDGER_REPLAY_REJECTED: 'ledger_replay_rejected',
  WEBHOOK_LATENCY: 'webhook_latency_ms',
  WEBHOOK_SIGNATURE_FAIL: 'webhook_signature_failures',
  WEBHOOK_REPLAY_ATTACK: 'webhook_replay_attack_attempts',
  WEBHOOK_DUPLICATE: 'webhook_duplicate_callback_count',
  DEAD_LETTER_DEPTH: 'dead_letter_queue_depth',
  SETTLEMENT_LATENCY: 'settlement_latency_ms',
  RECONCILIATION_DURATION: 'reconciliation_duration_ms',
  RUNTIME_HEALTH: 'runtime_health_status',
};

let _metrics = {};

function loadMetrics() {
  try {
    if (typeof sessionStorage === 'undefined') return;
    _metrics = JSON.parse(sessionStorage.getItem(METRICS_KEY) || '{}');
  } catch {
    _metrics = {};
  }
}

function saveMetrics() {
  try {
    if (typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(METRICS_KEY, JSON.stringify(_metrics));
  } catch {
    /* ignore */
  }
}

loadMetrics();

export function track(metric, value = 1, tags = {}) {
  if (!_metrics[metric]) {
    _metrics[metric] = { count: 0, sum: 0, min: Infinity, max: -Infinity, last: null, tags: {} };
  }

  const m = _metrics[metric];
  m.count += 1;
  m.sum += value;
  m.min = Math.min(m.min, value);
  m.max = Math.max(m.max, value);
  m.last = value;
  m.tags = { ...m.tags, ...tags };

  saveMetrics();
}

export function getMetrics() {
  loadMetrics();
  const snapshot = {};
  for (const [name, m] of Object.entries(_metrics)) {
    snapshot[name] = {
      ...m,
      avg: m.count > 0 ? Math.round((m.sum / m.count) * 100) / 100 : 0,
    };
  }
  return snapshot;
}

export function resetMetrics(metric) {
  if (metric) {
    delete _metrics[metric];
  } else {
    _metrics = {};
  }
  saveMetrics();
}
