/**
 * Policy Engine — Main orchestration layer.
 *
 * This module is the single entry point for all policy-based risk decisions.
 * It replaces hardcoded fraud/auth logic with configurable, auditable policy
 * evaluation — equivalent in intent to OPA, Cedar, or enterprise telecom
 * fraud orchestration systems.
 *
 * Public API:
 *   buildPolicyContext(txData, authContext)  — assemble evaluation context
 *   evaluatePolicies(context)               — run all enabled policies
 *   getPolicyDecision(txData, authContext)   — one-call convenience wrapper
 *
 * Safety guarantees:
 *   - NEVER throws — all errors return a safe ALLOW passthrough
 *   - NEVER blocks app rendering or payment flow boot
 *   - Circular evaluation is impossible (policies are stateless)
 *   - Respects EMERGENCY_DISABLE_ALL and POLICY_ENGINE_DRY_RUN flags
 *   - Backwards-compatible with adaptiveEscalation output shape
 */

import { evaluateDeviceRisk }              from '@/lib/deviceTrust';
import { evaluateCounterpartyReputation }  from '@/backend/fraud/reputationEngine';
import { evaluateSharedThreat }            from '@/backend/fraud/threatIntel';

import { getEnabledPolicies, getFeatureFlags } from './policyRegistry.js';
import { evaluatePolicySafe }                  from './policyEvaluator.js';
import {
  resolveActions,
  resolveEffect,
  classifyActions,
  buildAuthRequirements,
  describeSideEffects,
  computeCompositeScore,
}                                              from './policyActions.js';
import { appendPolicyEvaluationAudit }         from './policyAudit.js';
import { recordPolicyEvaluation, generateCorrelationId } from './policyMetrics.js';

// ── Velocity helper (reads fraud graph events from localStorage) ───────────────

const GRAPH_KEY = 'zuri_fraud_graph_v1';
const VELOCITY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function readRecentVelocity(fromPhone) {
  try {
    const graph = JSON.parse(localStorage.getItem(GRAPH_KEY) || '{"events":[]}');
    const events = Array.isArray(graph.events) ? graph.events : [];
    const cutoff = Date.now() - VELOCITY_WINDOW_MS;
    return events.filter(e => e.phone === fromPhone && (e.ts || 0) > cutoff).length;
  } catch {
    return 0;
  }
}

// ── Context builder ────────────────────────────────────────────────────────────

/**
 * Assemble a normalised policy evaluation context from transaction data and
 * optional auth-context overrides.  All enrichment calls are wrapped in
 * individual try/catch blocks — a failing signal source never prevents
 * evaluation from proceeding.
 *
 * @param {object} txData       — { amount, fromPhone, toPhone, txType, txRef, userId }
 * @param {object} authContext  — optional overrides: { failedAuthAttempts, simSwap, ... }
 * @returns {object} context
 */
export function buildPolicyContext(txData = {}, authContext = {}) {
  const {
    amount = 0,
    fromPhone,
    toPhone,
    txType = 'sendMoney',
    txRef  = '',
    userId = '',
  } = txData;

  // ── Base context with safe defaults ──
  const ctx = {
    amount,
    currency:                'KSH',
    txType,
    txRef,
    fromPhone:               fromPhone || '',
    toPhone:                 toPhone   || '',
    userId:                  userId    || '',

    // Risk signals — defaults, enriched below
    velocitySpike:           0,
    deviceTrust:             0.5,   // 0 = untrusted, 1 = fully trusted
    geoAnomaly:              false,
    impossibleTravel:        false,
    simSwap:                 false,
    vpnProxy:                false,
    timeOfDayRisk:           0.1,   // 0 = safe, 1 = high-risk time

    merchantTrust:           70,    // 0–100
    recipientTrust:          70,    // 0–100
    isNewRecipient:          false,

    failedAuthAttempts:      0,

    fraudReputation:         0,     // 0–100 risk
    txFrequency:             0,
    sharedThreatScore:       0,     // 0–100
    fraudGraphRisk:          0,     // 0–100

    webhookAnomaly:          false,
    settlementInconsistency: false,
    queueAnomaly:            false,

    correlationId:           generateCorrelationId('ctx'),
    timestamp:               new Date().toISOString(),
  };

  // ── Enrich: device trust ──
  try {
    const dr     = evaluateDeviceRisk();
    ctx.deviceTrust      = Math.max(0, Math.min(1, (100 - (dr.score || 0)) / 100));
    ctx.vpnProxy         = dr.signals?.some(s => s.code === 'vpn_proxy_suspicion') || false;
    ctx.impossibleTravel = dr.signals?.some(s => s.code === 'impossible_travel')   || false;
    ctx.simSwap          = dr.signals?.some(s => s.code === 'sim_swap_indicator')   || false;
    ctx.geoAnomaly       = dr.signals?.some(s => s.code === 'geolocation_shift')    || false;
  } catch {}

  // ── Enrich: counterparty reputation ──
  try {
    if (toPhone) {
      const rep          = evaluateCounterpartyReputation({ recipient: toPhone });
      ctx.recipientTrust = rep.trustScore ?? 70;
      ctx.fraudReputation = rep.riskScore  ?? 0;
      ctx.isNewRecipient  = !rep.known;
    }
  } catch {}

  // ── Enrich: shared threat intelligence ──
  try {
    const threat       = evaluateSharedThreat({ recipient: toPhone, amount });
    ctx.sharedThreatScore = threat.globalRisk ?? 0;
  } catch {}

  // ── Enrich: transaction velocity ──
  try {
    if (fromPhone) {
      const v           = readRecentVelocity(fromPhone);
      ctx.velocitySpike = v;
      ctx.txFrequency   = v;
    }
  } catch {}

  // ── Time-of-day risk ──
  try {
    const h = new Date().getHours();
    if      (h >= 0  && h < 4)  ctx.timeOfDayRisk = 0.9;
    else if (h >= 4  && h < 6)  ctx.timeOfDayRisk = 0.7;
    else if (h >= 22)            ctx.timeOfDayRisk = 0.6;
    else if (h >= 20)            ctx.timeOfDayRisk = 0.3;
    else                         ctx.timeOfDayRisk = 0.1;
  } catch {}

  // ── Apply caller-supplied overrides ──
  const OVERRIDABLE = [
    'failedAuthAttempts', 'simSwap', 'impossibleTravel', 'vpnProxy',
    'geoAnomaly', 'fraudGraphRisk', 'velocitySpike', 'webhookAnomaly',
    'settlementInconsistency', 'queueAnomaly',
  ];
  OVERRIDABLE.forEach(k => {
    if (authContext[k] !== undefined) ctx[k] = authContext[k];
  });

  return ctx;
}

// ── Policy evaluation ──────────────────────────────────────────────────────────

/**
 * Evaluate all enabled policies against a pre-built context.
 *
 * Returns a decision object that:
 *   - Is backwards-compatible with adaptiveEscalation output
 *   - Never throws
 *   - Respects dry-run and emergency-disable flags
 *
 * @param {object} context — output of buildPolicyContext()
 * @returns {object} decision
 */
export function evaluatePolicies(context) {
  const flags = getFeatureFlags();

  // ── Kill switches ──
  if (!flags.POLICY_ENGINE_ENABLED || flags.EMERGENCY_DISABLE_ALL) {
    return buildPassthrough(context, 'engine_disabled');
  }

  const t0         = performance.now();
  const isDryRun   = Boolean(flags.POLICY_ENGINE_DRY_RUN);

  // ── Load policies ──
  let policies = [];
  try {
    policies = getEnabledPolicies();
  } catch {
    return buildPassthrough(context, 'registry_error');
  }

  if (policies.length === 0) {
    return buildPassthrough(context, 'no_policies');
  }

  // ── Run evaluations (highest priority first, already sorted by registry) ──
  const results = [];
  for (const policy of policies) {
    const result = evaluatePolicySafe(policy, context);
    results.push(result);
  }

  const triggered  = results.filter(r => r.triggered);
  const actionSets = triggered.map(r => r.actions || []);

  const aggregatedActions = resolveActions(actionSets);
  // In dry-run mode the engine observes but never enforces
  const rawEffect         = resolveEffect(triggered);
  const finalEffect       = isDryRun ? 'ALLOW' : rawEffect;
  const classification    = classifyActions(aggregatedActions);
  const authRequirements  = buildAuthRequirements(aggregatedActions);
  const sideEffects       = describeSideEffects(aggregatedActions, context);
  const compositeScore    = computeCompositeScore(triggered);

  const evaluationLatencyMs = Math.round(performance.now() - t0);

  // ── Determine legacy-compatible output values ──
  const level = finalEffect === 'DENY'     ? 'critical'
              : finalEffect === 'ESCALATE' ? 'high'
              : finalEffect === 'REVIEW'   ? 'medium'
              : 'low';

  const decision = {
    // ── Core decision ──
    correlationId:     context.correlationId || generateCorrelationId('eval'),
    finalEffect,
    isDryRun,
    observedEffect:    rawEffect,       // actual effect before dry-run override

    // ── Actions & auth ──
    aggregatedActions,
    authRequirements,
    classification,
    sideEffects,

    // ── Triggered policy summary ──
    triggered: triggered.map(r => ({
      policyId:   r.policyId,
      policyName: r.policyName,
      severity:   r.severity,
      effect:     r.effect,
      actions:    r.actions,
    })),
    triggeredCount:  triggered.length,
    totalEvaluated:  policies.length,
    evaluationLatencyMs,
    decidedAt:       new Date().toISOString(),

    // ── Backwards compat with adaptiveEscalation ──
    score:           compositeScore,
    level,
    holdTransaction: classification.isHold && !isDryRun,
    settlementDelayMs: (classification.isDeny || classification.isHold) && !isDryRun
      ? 15 * 60 * 1000
      : 0,
    reasons: triggered.map(r => r.policyId),
    actions: aggregatedActions, // alias for legacy callers
  };

  // ── Non-blocking audit + metrics (errors silently discarded) ──
  try {
    appendPolicyEvaluationAudit({
      correlationId:     decision.correlationId,
      txRef:             context.txRef,
      userId:            context.userId,
      contextMeta: {
        amount:      context.amount,
        txType:      context.txType,
        deviceTrust: context.deviceTrust,
        fromPhone:   context.fromPhone,
      },
      triggeredPolicies: triggered,
      aggregatedActions,
      finalEffect,
      isDryRun,
      evaluationLatencyMs,
      policyVersion: 1,
    });
  } catch {}

  try {
    recordPolicyEvaluation({
      triggeredPolicies: triggered,
      finalEffect,
      actions:           aggregatedActions,
      evaluationLatencyMs,
      isDryRun,
    });
  } catch {}

  return decision;
}

// ── Convenience one-call wrapper ───────────────────────────────────────────────

/**
 * Build context from transaction data, then evaluate all policies.
 * This is the primary integration point for payment/auth flows.
 *
 * NEVER throws — returns an ALLOW passthrough on any failure.
 *
 * @param {object} txData      — transaction data
 * @param {object} authContext — optional auth signal overrides
 * @returns {object} decision  — includes .context for downstream use
 */
export function getPolicyDecision(txData = {}, authContext = {}) {
  try {
    const context  = buildPolicyContext(txData, authContext);
    const decision = evaluatePolicies(context);
    return { ...decision, context };
  } catch (err) {
    console.warn('[PolicyEngine] getPolicyDecision failed safely:', err?.message);
    return buildPassthrough({}, 'engine_exception');
  }
}

// ── Passthrough factory ───────────────────────────────────────────────────────

/**
 * Safe ALLOW passthrough returned whenever the engine is disabled,
 * misconfigured, or encounters an unrecoverable error.
 * Shape matches evaluatePolicies() output for drop-in compatibility.
 */
function buildPassthrough(context, reason) {
  return {
    correlationId:    context?.correlationId || generateCorrelationId('pass'),
    finalEffect:      'ALLOW',
    observedEffect:   'ALLOW',
    isDryRun:         false,
    aggregatedActions: [],
    authRequirements: {
      pin: false, faceAuth: false, webAuthn: false, voiceAuth: false,
      reauthentication: false, escalationLevel: 'NONE',
    },
    classification: {
      isDeny: false, isHold: false, isBlocked: false,
      authRequired: [], sideEffects: [], allActions: [],
    },
    sideEffects:       [],
    triggered:         [],
    triggeredCount:    0,
    totalEvaluated:    0,
    evaluationLatencyMs: 0,
    decidedAt:         new Date().toISOString(),
    // Backwards compat
    score:             0,
    level:             'low',
    holdTransaction:   false,
    settlementDelayMs: 0,
    reasons:           [],
    actions:           [],
    // Passthrough metadata
    passthrough:       true,
    passthroughReason: reason,
  };
}
