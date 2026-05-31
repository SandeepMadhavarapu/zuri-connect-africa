/**
 * Policy Engine — Per-policy evaluator.
 *
 * Evaluates a single policy against a context object. This module is
 * deliberately narrow: it knows nothing about storage, side effects,
 * or aggregation — all of that lives in policyEngine.js.
 *
 * Every public function is exception-safe (never throws).
 */

import { evaluateConditions, getConditionTrace } from './policyConditions.js';
import { classifyActions } from './policyActions.js';

// ── Rollout gate ───────────────────────────────────────────────────────────────

/**
 * Determine whether a policy should fire for this evaluation based on
 * its rolloutPercentage. Uses a deterministic hash of the policy ID so
 * the same policy always lands in the same bucket (stable rollout).
 */
function isInRollout(policy) {
  const pct = policy.rolloutPercentage ?? 100;
  if (pct >= 100) return true;
  if (pct <= 0)   return false;

  // Hash the policy ID to a stable 0-99 bucket
  let h = 0;
  for (let i = 0; i < policy.id.length; i++) {
    h = (h * 31 + policy.id.charCodeAt(i)) >>> 0;
  }
  return (h % 100) < pct;
}

// ── Core evaluator ─────────────────────────────────────────────────────────────

/**
 * Evaluate a single policy against a context.
 *
 * Returns:
 *   { triggered: false, reason, latencyMs, policy }
 *   { triggered: true,  policyId, policyName, severity, effect, actions,
 *     classification, conditionTrace, latencyMs, policy }
 */
export function evaluatePolicy(policy, context) {
  if (!policy) {
    return { triggered: false, reason: 'null_policy', latencyMs: 0, policy };
  }

  if (!policy.enabled) {
    return { triggered: false, reason: 'policy_disabled', latencyMs: 0, policy };
  }

  if (!isInRollout(policy)) {
    return { triggered: false, reason: 'outside_rollout', latencyMs: 0, policy };
  }

  const t0 = performance.now();

  let triggered      = false;
  let conditionTrace = [];
  let evalError      = null;

  try {
    triggered      = evaluateConditions(policy.conditions, context);
    conditionTrace = getConditionTrace(policy.conditions, context);
  } catch (err) {
    evalError = err.message;
    triggered = false; // safe fallback
  }

  const latencyMs = Math.round(performance.now() - t0);

  if (evalError) {
    return { triggered: false, reason: 'evaluation_error', error: evalError, latencyMs, policy };
  }

  if (!triggered) {
    return { triggered: false, reason: 'conditions_not_met', latencyMs, policy };
  }

  const classification = classifyActions(policy.actions || []);

  return {
    triggered:      true,
    policyId:       policy.id,
    policyName:     policy.name,
    severity:       policy.severity,
    effect:         policy.effect,
    actions:        policy.actions || [],
    classification,
    conditionTrace,
    latencyMs,
    policy,
  };
}

/**
 * Evaluate a policy with a hard-stop guard.
 *
 * evaluatePolicy() is synchronous and should be fast, but this wrapper
 * adds an explicit try/catch so any unexpected runtime error is absorbed
 * and the call site receives a safe passthrough result.
 */
export function evaluatePolicySafe(policy, context) {
  try {
    return evaluatePolicy(policy, context);
  } catch {
    return {
      triggered:  false,
      reason:     'safe_fallback',
      latencyMs:  0,
      policy,
    };
  }
}

// ── Batch evaluator (used by simulator) ───────────────────────────────────────

/**
 * Evaluate a list of policies against a context.
 * Returns all results (triggered and not), sorted by policy priority desc.
 */
export function evaluatePoliciesBatch(policies, context) {
  const sorted = [...policies].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  return sorted.map(p => evaluatePolicySafe(p, context));
}

// ── Human-readable evaluation report ──────────────────────────────────────────

/**
 * Produce a summary object useful for policy debugger UI and logs.
 */
export function generateEvaluationReport(result) {
  if (!result) return { summary: 'No result', triggered: false };

  if (!result.triggered) {
    return {
      summary:   `"${result.policy?.name || result.policy?.id}" did not trigger (${result.reason || 'unknown'})`,
      triggered: false,
      policyId:  result.policy?.id,
      reason:    result.reason,
      latencyMs: result.latencyMs,
    };
  }

  return {
    summary:      `"${result.policyName}" triggered → ${result.effect} (${result.severity})`,
    triggered:    true,
    policyId:     result.policyId,
    policyName:   result.policyName,
    severity:     result.severity,
    effect:       result.effect,
    actions:      result.actions,
    authRequired: result.classification?.authRequired || [],
    isBlocked:    result.classification?.isBlocked    || false,
    latencyMs:    result.latencyMs,
  };
}
