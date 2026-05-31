/**
 * Policy Engine — Schemas, constants, and validation.
 * Pure module: no imports, no side effects.
 */

// ── Condition rule operators ───────────────────────────────────────────────────

export const POLICY_OPERATORS = {
  EQ:         '==',
  NEQ:        '!=',
  GT:         '>',
  GTE:        '>=',
  LT:         '<',
  LTE:        '<=',
  IN:         'in',
  NOT_IN:     'not_in',
  CONTAINS:   'contains',
  MATCHES:    'matches',
  EXISTS:     'exists',
  NOT_EXISTS: 'not_exists',
};

// ── Condition group operators ──────────────────────────────────────────────────

export const CONDITION_GROUP_OPERATORS = ['AND', 'OR', 'NOT'];

// ── Severity levels ────────────────────────────────────────────────────────────

export const SEVERITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const SEVERITY_SCORE_MAP = {
  LOW:      20,
  MEDIUM:   45,
  HIGH:     70,
  CRITICAL: 90,
};

// ── Policy effects ─────────────────────────────────────────────────────────────

export const POLICY_EFFECTS = {
  ALLOW:    'ALLOW',
  DENY:     'DENY',
  ESCALATE: 'ESCALATE',
  REVIEW:   'REVIEW',
};

// DENY wins over all; ALLOW is weakest
export const EFFECT_PRECEDENCE = {
  DENY:     0,
  REVIEW:   1,
  ESCALATE: 2,
  ALLOW:    3,
};

// ── Supported policy actions ───────────────────────────────────────────────────

export const POLICY_ACTIONS = [
  'requirePIN',
  'requireFaceAuth',
  'requireWebAuthn',
  'requireVoiceAuth',
  'queueManualReview',
  'holdTransaction',
  'denyTransaction',
  'throttleTransaction',
  'emitFraudEvent',
  'increaseFraudSensitivity',
  'escalateToSOC',
  'triggerCooldown',
  'requireReauthentication',
];

// ── Supported condition context fields ────────────────────────────────────────

export const CONDITION_FIELDS = [
  // Transaction
  'amount', 'currency', 'txType', 'txRef', 'fromPhone', 'toPhone',
  // Velocity / frequency
  'velocitySpike', 'txFrequency',
  // Device
  'deviceTrust',
  // Geo / travel
  'geoAnomaly', 'impossibleTravel',
  // SIM / network
  'simSwap', 'vpnProxy',
  // Time
  'timeOfDayRisk',
  // Counterparty trust
  'merchantTrust', 'recipientTrust', 'isNewRecipient',
  // Auth signals
  'failedAuthAttempts',
  // Fraud signals
  'fraudReputation', 'sharedThreatScore', 'fraudGraphRisk',
  // Infrastructure
  'webhookAnomaly', 'settlementInconsistency', 'queueAnomaly',
];

// ── Validation ─────────────────────────────────────────────────────────────────

export function validatePolicyRule(rule) {
  const errors = [];
  if (!rule || typeof rule !== 'object') return ['rule must be an object'];
  if (!rule.field || typeof rule.field !== 'string') errors.push('rule.field is required');
  if (!rule.operator) errors.push('rule.operator is required');
  if (rule.operator && !Object.values(POLICY_OPERATORS).includes(rule.operator)) {
    errors.push(`unknown operator "${rule.operator}"`);
  }
  return errors;
}

export function validatePolicyConditions(conditions) {
  if (!conditions) return [];
  const errors = [];

  if (Array.isArray(conditions)) {
    conditions.forEach((rule, i) => {
      validatePolicyRule(rule).forEach(e => errors.push(`conditions[${i}]: ${e}`));
    });
    return errors;
  }

  if (typeof conditions === 'object' && conditions.operator) {
    if (!CONDITION_GROUP_OPERATORS.includes(conditions.operator)) {
      errors.push(`invalid group operator "${conditions.operator}"`);
    }
    if (!Array.isArray(conditions.rules)) {
      errors.push('conditions.rules must be an array');
    } else {
      conditions.rules.forEach((rule, i) => {
        if (rule.rules) {
          // nested group — recurse
          validatePolicyConditions(rule).forEach(e => errors.push(`conditions.rules[${i}].${e}`));
        } else {
          validatePolicyRule(rule).forEach(e => errors.push(`conditions.rules[${i}]: ${e}`));
        }
      });
    }
    return errors;
  }

  errors.push('conditions must be an array of rules or a { operator, rules } group');
  return errors;
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') {
    return { valid: false, errors: ['policy must be an object'] };
  }

  const errors = [];

  if (!policy.id || typeof policy.id !== 'string') errors.push('id is required');
  if (!policy.name || typeof policy.name !== 'string') errors.push('name is required');
  if (typeof policy.enabled !== 'boolean') errors.push('enabled must be boolean');

  if (typeof policy.priority !== 'number' || policy.priority < 0 || policy.priority > 100) {
    errors.push('priority must be a number between 0 and 100');
  }

  if (!SEVERITY_LEVELS.includes(policy.severity)) {
    errors.push(`severity must be one of: ${SEVERITY_LEVELS.join(', ')}`);
  }

  if (!Object.values(POLICY_EFFECTS).includes(policy.effect)) {
    errors.push(`effect must be one of: ${Object.values(POLICY_EFFECTS).join(', ')}`);
  }

  if (!Array.isArray(policy.actions)) {
    errors.push('actions must be an array');
  } else {
    const invalid = policy.actions.filter(a => !POLICY_ACTIONS.includes(a));
    if (invalid.length > 0) errors.push(`unknown actions: ${invalid.join(', ')}`);
  }

  if (typeof policy.rolloutPercentage !== 'number' ||
      policy.rolloutPercentage < 0 || policy.rolloutPercentage > 100) {
    errors.push('rolloutPercentage must be a number between 0 and 100');
  }

  if (policy.conditions) {
    validatePolicyConditions(policy.conditions).forEach(e => errors.push(e));
  }

  return { valid: errors.length === 0, errors };
}

// ── Template factory ───────────────────────────────────────────────────────────

export function createPolicyTemplate(overrides = {}) {
  const now = new Date().toISOString();
  const base = {
    id:                 `pol_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name:               'New Policy',
    description:        '',
    enabled:            false,
    priority:           50,
    severity:           'MEDIUM',
    effect:             'ESCALATE',
    rolloutPercentage:  0,
    version:            1,
    conditions: {
      operator: 'AND',
      rules:    [],
    },
    actions:  [],
    metadata: {
      createdAt:  now,
      updatedAt:  now,
      createdBy:  'system',
      tags:       [],
    },
  };

  return {
    ...base,
    ...overrides,
    // metadata always gets fresh timestamps on creation
    metadata: {
      ...base.metadata,
      ...(overrides.metadata || {}),
      createdAt: now,
      updatedAt: now,
    },
  };
}
