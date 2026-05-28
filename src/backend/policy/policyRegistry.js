/**
 * Policy Engine — Registry (storage, CRUD, feature flags, rollout).
 *
 * Responsibilities:
 *   - Persist policies in localStorage (append-only history preserved separately)
 *   - Provide getEnabledPolicies() — the hot path called on every evaluation
 *   - Manage feature flags: engine on/off, dry-run mode, emergency kill switch
 *   - Support rollout-safe activation (0–100 % rollout per policy)
 *   - Prevent mutation of built-in policy IDs (soft-lock)
 *   - Export / import for operational tooling
 */

import { validatePolicy, createPolicyTemplate } from './policySchemas.js';

// ── Storage keys ───────────────────────────────────────────────────────────────

const REGISTRY_KEY = 'zuri_policy_registry_v1';
const FLAGS_KEY    = 'zuri_policy_flags_v1';
const HISTORY_KEY  = 'zuri_policy_history_v1';

const MAX_HISTORY  = 300;

// ── Built-in policy creation date (stable, not regenerated on every import) ────
const BUILTIN_DATE = '2024-01-01T00:00:00.000Z';

function builtinMeta(tags = []) {
  return { createdAt: BUILTIN_DATE, updatedAt: BUILTIN_DATE, createdBy: 'system', tags };
}

// ── Default built-in policies ──────────────────────────────────────────────────
// These are loaded once, then overridden by localStorage on subsequent boots.

const DEFAULT_POLICIES = [

  // 1. SIM swap — highest priority, hard block
  {
    id:                'pol_sim_swap_block',
    name:              'SIM Swap — Hard Block',
    description:       'Deny all transactions when a SIM swap signal is detected. Escalate to SOC.',
    enabled:           true,
    priority:          100,
    severity:          'CRITICAL',
    effect:            'DENY',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'simSwap', operator: '==', value: true },
      ],
    },
    actions:  ['denyTransaction', 'emitFraudEvent', 'escalateToSOC', 'triggerCooldown'],
    metadata: builtinMeta(['fraud', 'sim-swap', 'critical']),
  },

  // 2. Critical fraud reputation — hard block
  {
    id:                'pol_critical_reputation',
    name:              'Critical Fraud Reputation — Deny',
    description:       'Deny transactions to recipients whose fraud reputation score exceeds 80.',
    enabled:           true,
    priority:          98,
    severity:          'CRITICAL',
    effect:            'DENY',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'fraudReputation', operator: '>', value: 80 },
        { field: 'recipientTrust',  operator: '<', value: 15 },
      ],
    },
    actions:  ['denyTransaction', 'emitFraudEvent', 'escalateToSOC'],
    metadata: builtinMeta(['fraud', 'reputation', 'critical']),
  },

  // 3. High-value new recipient with low device trust — step-up
  {
    id:                'pol_high_value_new_recipient',
    name:              'High Value — New Recipient + Untrusted Device',
    description:       'Require strong auth for large transfers to previously unseen recipients on untrusted devices.',
    enabled:           true,
    priority:          95,
    severity:          'HIGH',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'amount',         operator: '>',  value: 50000 },
        { field: 'isNewRecipient', operator: '==', value: true  },
        { field: 'deviceTrust',    operator: '<',  value: 0.5   },
      ],
    },
    actions:  ['requirePIN', 'requireFaceAuth', 'queueManualReview', 'increaseFraudSensitivity'],
    metadata: builtinMeta(['fraud', 'high-value', 'new-recipient']),
  },

  // 4. Impossible travel — strong step-up
  {
    id:                'pol_impossible_travel',
    name:              'Impossible Travel Detected',
    description:       'Require WebAuthn + face auth when impossible travel velocity is detected.',
    enabled:           true,
    priority:          92,
    severity:          'HIGH',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'impossibleTravel', operator: '==', value: true },
      ],
    },
    actions:  ['requireWebAuthn', 'requireFaceAuth', 'queueManualReview', 'emitFraudEvent'],
    metadata: builtinMeta(['geo', 'travel', 'fraud']),
  },

  // 5. High shared threat intelligence score
  {
    id:                'pol_shared_threat_cluster',
    name:              'Known Shared Threat Cluster',
    description:       'Hold and review transactions matching high-risk cross-user threat patterns.',
    enabled:           true,
    priority:          90,
    severity:          'CRITICAL',
    effect:            'REVIEW',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'sharedThreatScore', operator: '>', value: 60 },
      ],
    },
    actions:  ['holdTransaction', 'queueManualReview', 'emitFraudEvent', 'increaseFraudSensitivity'],
    metadata: builtinMeta(['threat-intel', 'fraud', 'critical']),
  },

  // 6. Velocity spike on significant amounts
  {
    id:                'pol_velocity_spike',
    name:              'Transaction Velocity Spike',
    description:       'Hold and require re-auth when more than 3 transactions have been made in 10 minutes.',
    enabled:           true,
    priority:          85,
    severity:          'HIGH',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'velocitySpike', operator: '>', value: 3    },
        { field: 'amount',        operator: '>', value: 5000 },
      ],
    },
    actions:  ['holdTransaction', 'requireReauthentication', 'emitFraudEvent'],
    metadata: builtinMeta(['velocity', 'fraud']),
  },

  // 7. Multiple failed auth attempts — cooldown
  {
    id:                'pol_failed_auth_cooldown',
    name:              'Multiple Failed Auth Attempts',
    description:       'Trigger a cooldown and force re-authentication after 3+ failed attempts.',
    enabled:           true,
    priority:          88,
    severity:          'HIGH',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'failedAuthAttempts', operator: '>=', value: 3 },
      ],
    },
    actions:  ['triggerCooldown', 'requireReauthentication', 'emitFraudEvent'],
    metadata: builtinMeta(['auth', 'brute-force']),
  },

  // 8. Untrusted device — high value transaction
  {
    id:                'pol_untrusted_device_high_value',
    name:              'Untrusted Device — High Value',
    description:       'Require WebAuthn for transactions above 10 000 KSh from a very low-trust device.',
    enabled:           true,
    priority:          80,
    severity:          'HIGH',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'deviceTrust', operator: '<', value: 0.3   },
        { field: 'amount',      operator: '>', value: 10000 },
      ],
    },
    actions:  ['requireWebAuthn', 'requireFaceAuth', 'emitFraudEvent'],
    metadata: builtinMeta(['device', 'high-value']),
  },

  // 9. VPN / proxy + significant amount
  {
    id:                'pol_vpn_proxy_high_value',
    name:              'VPN/Proxy — High Value Transaction',
    description:       'Require step-up auth for transactions above 20 000 KSh originating via VPN or proxy.',
    enabled:           true,
    priority:          75,
    severity:          'MEDIUM',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'vpnProxy', operator: '==', value: true  },
        { field: 'amount',   operator: '>',  value: 20000 },
      ],
    },
    actions:  ['requireWebAuthn', 'requirePIN'],
    metadata: builtinMeta(['vpn', 'proxy', 'high-value']),
  },

  // 10. High-risk time window + significant amount
  {
    id:                'pol_time_of_day_risk',
    name:              'High-Risk Time Window',
    description:       'Require PIN + face auth for transactions above 10 000 KSh during high-risk hours (midnight–6 am).',
    enabled:           true,
    priority:          65,
    severity:          'MEDIUM',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'timeOfDayRisk', operator: '>', value: 0.65  },
        { field: 'amount',        operator: '>', value: 10000 },
      ],
    },
    actions:  ['requirePIN', 'requireFaceAuth'],
    metadata: builtinMeta(['time-risk']),
  },

  // 11. High fraud graph risk on recipient node
  {
    id:                'pol_fraud_graph_risk',
    name:              'High Fraud Graph Risk — Recipient',
    description:       'Escalate when the recipient node carries high risk in the fraud relationship graph.',
    enabled:           true,
    priority:          78,
    severity:          'HIGH',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'fraudGraphRisk', operator: '>', value: 65 },
        { field: 'amount',         operator: '>', value: 1000 },
      ],
    },
    actions:  ['requireFaceAuth', 'queueManualReview', 'emitFraudEvent'],
    metadata: builtinMeta(['fraud-graph', 'reputation']),
  },

  // 12. Geo anomaly on large transaction
  {
    id:                'pol_geo_anomaly',
    name:              'Geolocation Anomaly',
    description:       'Require WebAuthn when a significant location shift is detected on a transaction above 5 000 KSh.',
    enabled:           true,
    priority:          70,
    severity:          'MEDIUM',
    effect:            'ESCALATE',
    rolloutPercentage: 100,
    version:           1,
    conditions: {
      operator: 'AND',
      rules: [
        { field: 'geoAnomaly', operator: '==', value: true  },
        { field: 'amount',     operator: '>',  value: 5000  },
      ],
    },
    actions:  ['requireWebAuthn', 'requirePIN', 'emitFraudEvent'],
    metadata: builtinMeta(['geo', 'anomaly']),
  },
];

// IDs that cannot be deleted (soft-lock for built-ins)
const BUILTIN_IDS = new Set(DEFAULT_POLICIES.map(p => p.id));

// ── Default feature flags ──────────────────────────────────────────────────────

const DEFAULT_FLAGS = {
  POLICY_ENGINE_ENABLED:    true,   // master on/off switch
  POLICY_ENGINE_DRY_RUN:    false,  // evaluate but never enforce (observe only)
  EMERGENCY_DISABLE_ALL:    false,  // instant kill-switch
  MAX_EVALUATION_TIMEOUT_MS: 200,   // per-policy evaluation ceiling
  DENY_REQUIRES_CRITICAL:   false,  // if true, DENY effect only fires on CRITICAL severity
};

// ── Storage helpers ────────────────────────────────────────────────────────────

function loadRegistry() {
  try {
    const stored = localStorage.getItem(REGISTRY_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && Array.isArray(parsed.policies)) return parsed;
    }
  } catch {}
  return { policies: DEFAULT_POLICIES.map(p => ({ ...p })), schemaVersion: 1 };
}

function saveRegistry(registry) {
  try {
    localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
  } catch {}
}

function loadFlags() {
  try {
    const stored = localStorage.getItem(FLAGS_KEY);
    if (stored) return { ...DEFAULT_FLAGS, ...JSON.parse(stored) };
  } catch {}
  return { ...DEFAULT_FLAGS };
}

function saveFlags(flags) {
  try {
    localStorage.setItem(FLAGS_KEY, JSON.stringify(flags));
  } catch {}
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    const trimmed = history.length > MAX_HISTORY
      ? history.slice(history.length - MAX_HISTORY)
      : history;
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch {}
}

function recordHistory(changeType, policyId, before, after) {
  const history = loadHistory();
  history.push({
    id:         `hist_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
    changeType,
    policyId,
    before:     before ? { id: before.id, name: before.name, enabled: before.enabled, version: before.version } : null,
    after:      after  ? { id: after.id,  name: after.name,  enabled: after.enabled,  version: after.version  } : null,
    timestamp:  new Date().toISOString(),
  });
  saveHistory(history);
}

// ── Read ───────────────────────────────────────────────────────────────────────

export function getAllPolicies() {
  return loadRegistry().policies;
}

/**
 * Hot path: return policies that should be evaluated right now.
 * - Honours EMERGENCY_DISABLE_ALL and POLICY_ENGINE_ENABLED flags
 * - Returns only enabled policies
 * - Sorted by priority descending (highest first)
 */
export function getEnabledPolicies() {
  const flags = loadFlags();
  if (!flags.POLICY_ENGINE_ENABLED || flags.EMERGENCY_DISABLE_ALL) return [];

  return loadRegistry().policies
    .filter(p => p.enabled)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0));
}

export function getPolicyById(id) {
  return loadRegistry().policies.find(p => p.id === id) || null;
}

export function isBuiltInPolicy(id) {
  return BUILTIN_IDS.has(id);
}

// ── Create ─────────────────────────────────────────────────────────────────────

export function createPolicy(data) {
  const policy = createPolicyTemplate(data);
  const { valid, errors } = validatePolicy(policy);
  if (!valid) throw new Error(`Invalid policy: ${errors.join('; ')}`);

  const registry = loadRegistry();
  if (registry.policies.find(p => p.id === policy.id)) {
    throw new Error(`Policy "${policy.id}" already exists`);
  }

  registry.policies.push(policy);
  saveRegistry(registry);
  recordHistory('create', policy.id, null, policy);
  return policy;
}

// ── Update ─────────────────────────────────────────────────────────────────────

export function updatePolicy(id, updates) {
  const registry = loadRegistry();
  const idx      = registry.policies.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Policy "${id}" not found`);

  const before  = registry.policies[idx];
  const updated = {
    ...before,
    ...updates,
    id:       before.id,           // ID is immutable
    version:  (before.version || 1) + 1,
    metadata: {
      ...(before.metadata || {}),
      ...(updates.metadata || {}),
      updatedAt: new Date().toISOString(),
    },
  };

  const { valid, errors } = validatePolicy(updated);
  if (!valid) throw new Error(`Invalid policy update: ${errors.join('; ')}`);

  registry.policies[idx] = updated;
  saveRegistry(registry);
  recordHistory('update', id, before, updated);
  return updated;
}

export function enablePolicy(id) {
  return updatePolicy(id, { enabled: true });
}

export function disablePolicy(id) {
  return updatePolicy(id, { enabled: false });
}

export function setRolloutPercentage(id, percentage) {
  const clamped = Math.max(0, Math.min(100, Number(percentage) || 0));
  return updatePolicy(id, { rolloutPercentage: clamped });
}

// ── Delete ─────────────────────────────────────────────────────────────────────

export function deletePolicy(id) {
  if (BUILTIN_IDS.has(id)) {
    throw new Error(`Cannot delete built-in policy "${id}". Use disablePolicy() instead.`);
  }

  const registry = loadRegistry();
  const idx      = registry.policies.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Policy "${id}" not found`);

  const [removed] = registry.policies.splice(idx, 1);
  saveRegistry(registry);
  recordHistory('delete', id, removed, null);
  return removed;
}

// ── Feature flags ──────────────────────────────────────────────────────────────

export function getFeatureFlags() {
  return loadFlags();
}

export function updateFeatureFlags(updates) {
  const flags = { ...loadFlags(), ...updates };
  saveFlags(flags);
  return flags;
}

/**
 * Emergency kill-switch: disable the entire policy engine instantly.
 * All evaluatePolicies() calls will return ALLOW passthrough.
 */
export function emergencyDisableAll(reason = '') {
  const flags = updateFeatureFlags({ EMERGENCY_DISABLE_ALL: true });
  recordHistory('emergency_disable', '_all', null, { reason, ts: Date.now() });
  return flags;
}

export function emergencyEnableAll() {
  const flags = updateFeatureFlags({ EMERGENCY_DISABLE_ALL: false });
  recordHistory('emergency_enable', '_all', null, { ts: Date.now() });
  return flags;
}

export function enableDryRunMode() {
  return updateFeatureFlags({ POLICY_ENGINE_DRY_RUN: true });
}

export function disableDryRunMode() {
  return updateFeatureFlags({ POLICY_ENGINE_DRY_RUN: false });
}

// ── History ────────────────────────────────────────────────────────────────────

export function getPolicyHistory(id) {
  const history = loadHistory();
  return id ? history.filter(h => h.policyId === id) : history;
}

// ── Import / export ────────────────────────────────────────────────────────────

export function exportPolicies() {
  return {
    exportedAt:    new Date().toISOString(),
    schemaVersion: 1,
    flags:         getFeatureFlags(),
    policies:      getAllPolicies(),
  };
}

export function importPolicies(exportBundle) {
  if (!exportBundle || !Array.isArray(exportBundle.policies)) {
    throw new Error('Invalid export bundle: missing policies array');
  }

  const errors = [];
  exportBundle.policies.forEach(p => {
    const { valid, errors: errs } = validatePolicy(p);
    if (!valid) errors.push(`${p.id || 'unknown'}: ${errs.join(', ')}`);
  });
  if (errors.length > 0) throw new Error(`Import validation failed:\n${errors.join('\n')}`);

  const registry = { policies: exportBundle.policies, schemaVersion: 1 };
  saveRegistry(registry);
  if (exportBundle.flags) saveFlags({ ...DEFAULT_FLAGS, ...exportBundle.flags });
  return registry;
}

export function resetToDefaults() {
  const registry = { policies: DEFAULT_POLICIES.map(p => ({ ...p })), schemaVersion: 1 };
  saveRegistry(registry);
  saveFlags({ ...DEFAULT_FLAGS });
  recordHistory('reset', '_all', null, { ts: Date.now() });
  return registry;
}
