/**
 * Policy Engine — Action resolution and classification.
 *
 * Handles:
 *   - Deduplication and priority ordering of collected actions
 *   - Effect precedence resolution across multiple triggered policies
 *   - Auth requirement extraction (escalation level mapping)
 *   - Side-effect descriptors (for audit / observability consumers)
 *
 * Pure module: no storage, no imports, no side effects.
 */

// ── Action execution priority ──────────────────────────────────────────────────
// Lower number = higher priority (processed first, wins in conflicts).

export const ACTION_PRIORITY = {
  denyTransaction:          1,
  holdTransaction:          2,
  escalateToSOC:            3,
  triggerCooldown:          4,
  emitFraudEvent:           5,
  queueManualReview:        6,
  requireReauthentication:  7,
  requireWebAuthn:          8,
  requireVoiceAuth:         9,
  requireFaceAuth:          10,
  requirePIN:               11,
  increaseFraudSensitivity: 12,
  throttleTransaction:      13,
};

// ── Action category sets ───────────────────────────────────────────────────────

const AUTH_ACTIONS = new Set([
  'requirePIN',
  'requireFaceAuth',
  'requireWebAuthn',
  'requireVoiceAuth',
  'requireReauthentication',
]);

const BLOCK_ACTIONS = new Set([
  'denyTransaction',
  'holdTransaction',
]);

const SIDE_EFFECT_ACTIONS = new Set([
  'emitFraudEvent',
  'increaseFraudSensitivity',
  'escalateToSOC',
  'triggerCooldown',
  'queueManualReview',
  'throttleTransaction',
]);

// ── Effect precedence: DENY wins over all; ALLOW loses to all ─────────────────

const EFFECT_PRECEDENCE = {
  DENY:     0,
  REVIEW:   1,
  ESCALATE: 2,
  ALLOW:    3,
};

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Merge and deduplicate actions from multiple triggered policies,
 * sorted by execution priority (highest priority first).
 *
 * @param  {string[][]} actionSets — one array of action strings per triggered policy
 * @returns {string[]} sorted, deduplicated action list
 */
export function resolveActions(actionSets) {
  const flat = actionSets.flat();
  const unique = [...new Set(flat)];
  return unique.sort((a, b) =>
    (ACTION_PRIORITY[a] ?? 99) - (ACTION_PRIORITY[b] ?? 99)
  );
}

/**
 * Determine the final policy effect from all triggered policies.
 * DENY overrides ESCALATE overrides REVIEW overrides ALLOW.
 *
 * @param  {{ effect: string }[]} triggeredPolicies
 * @returns {'ALLOW'|'DENY'|'ESCALATE'|'REVIEW'}
 */
export function resolveEffect(triggeredPolicies) {
  if (!triggeredPolicies || triggeredPolicies.length === 0) return 'ALLOW';

  let winner = 'ALLOW';
  for (const p of triggeredPolicies) {
    const effect = p.effect || 'ALLOW';
    if ((EFFECT_PRECEDENCE[effect] ?? 99) < (EFFECT_PRECEDENCE[winner] ?? 99)) {
      winner = effect;
    }
  }
  return winner;
}

/**
 * Classify a resolved action list into semantic groups.
 */
export function classifyActions(actions) {
  const arr = Array.isArray(actions) ? actions : [];
  return {
    isDeny:       arr.includes('denyTransaction'),
    isHold:       arr.includes('holdTransaction'),
    isBlocked:    arr.some(a => BLOCK_ACTIONS.has(a)),
    authRequired: arr.filter(a => AUTH_ACTIONS.has(a)),
    sideEffects:  arr.filter(a => SIDE_EFFECT_ACTIONS.has(a)),
    allActions:   arr,
  };
}

/**
 * Convert action list into structured auth requirements.
 * Maps to the format consumed by existing biometric / PIN / WebAuthn flows.
 *
 * Escalation levels (additive):
 *   NONE     — no auth required
 *   LOW      — PIN only
 *   MEDIUM   — PIN + Face ID
 *   HIGH     — PIN + Face ID + WebAuthn
 *   CRITICAL — all of the above + forced re-authentication
 */
export function buildAuthRequirements(actions) {
  const arr = Array.isArray(actions) ? actions : [];

  const reqs = {
    pin:              arr.includes('requirePIN'),
    faceAuth:         arr.includes('requireFaceAuth'),
    webAuthn:         arr.includes('requireWebAuthn'),
    voiceAuth:        arr.includes('requireVoiceAuth'),
    reauthentication: arr.includes('requireReauthentication'),
  };

  let escalationLevel = 'NONE';
  if (reqs.pin)              escalationLevel = 'LOW';
  if (reqs.faceAuth)         escalationLevel = 'MEDIUM';
  if (reqs.webAuthn)         escalationLevel = 'HIGH';
  if (reqs.reauthentication) escalationLevel = 'CRITICAL';

  return { ...reqs, escalationLevel };
}

/**
 * Map legacy adaptiveEscalation action strings to policy action strings.
 * Allows interoperability with the existing fraud escalation system.
 */
export function mapLegacyEscalationActions(legacyActions) {
  const LEGACY_MAP = {
    pin:              'requirePIN',
    face_id:          'requireFaceAuth',
    webauthn:         'requireWebAuthn',
    step_up_auth:     'requireReauthentication',
    pending_review:   'queueManualReview',
    temporary_hold:   'holdTransaction',
  };

  return (legacyActions || [])
    .map(a => LEGACY_MAP[a] || a)
    .filter(a => ACTION_PRIORITY[a] !== undefined);
}

/**
 * Describe the side effects that will be triggered, for audit / observability.
 * Returns an array of structured descriptor objects consumed by the engine.
 */
export function describeSideEffects(actions, context = {}) {
  const arr = Array.isArray(actions) ? actions : [];
  const effects = [];

  if (arr.includes('emitFraudEvent')) {
    effects.push({
      type:     'fraud_event',
      severity: 'HIGH',
      txRef:    context.txRef   || null,
      userId:   context.userId  || null,
    });
  }

  if (arr.includes('triggerCooldown')) {
    effects.push({
      type:       'cooldown',
      durationMs: 15 * 60 * 1000, // 15 minutes
      userId:     context.userId  || null,
      fromPhone:  context.fromPhone || null,
    });
  }

  if (arr.includes('escalateToSOC')) {
    effects.push({
      type:          'soc_escalation',
      priority:      'CRITICAL',
      correlationId: context.correlationId || null,
      txRef:         context.txRef || null,
    });
  }

  if (arr.includes('queueManualReview')) {
    effects.push({
      type:          'manual_review',
      txRef:         context.txRef || null,
      correlationId: context.correlationId || null,
    });
  }

  if (arr.includes('increaseFraudSensitivity')) {
    effects.push({
      type:   'sensitivity_increase',
      txRef:  context.txRef || null,
    });
  }

  if (arr.includes('throttleTransaction')) {
    effects.push({
      type:      'throttle',
      fromPhone: context.fromPhone || null,
    });
  }

  return effects;
}

/**
 * Compute a composite risk score from triggered policies (0–100).
 * Used for compatibility with systems that expect a numeric score.
 */
export function computeCompositeScore(triggeredPolicies) {
  if (!triggeredPolicies || triggeredPolicies.length === 0) return 0;

  const SEVERITY_SCORE = { LOW: 20, MEDIUM: 45, HIGH: 70, CRITICAL: 90 };
  const scores = triggeredPolicies.map(p => SEVERITY_SCORE[p.severity] || 0);
  return Math.min(100, Math.max(...scores));
}
