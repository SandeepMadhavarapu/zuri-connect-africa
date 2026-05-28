/**
 * Policy Engine — Simulator.
 *
 * Enterprise-grade fraud-tuning infrastructure:
 *   - Dry-run: evaluate policies without enforcing decisions
 *   - Replay: run policies against historical transaction data
 *   - A/B comparison: compare two context scenarios side-by-side
 *   - False-positive estimation: quantify policy precision on known-good samples
 *   - Attack simulation: stress-test policies against crafted adversarial inputs
 *
 * All simulation runs are marked isDryRun = true in audit and metrics.
 */

import { evaluatePolicySafe }   from './policyEvaluator.js';
import { getEnabledPolicies }   from './policyRegistry.js';
import { resolveActions, resolveEffect }             from './policyActions.js';
import { generateCorrelationId }                     from './policyMetrics.js';

// ── Context builder for historical / synthetic transactions ───────────────────

/**
 * Normalise a raw transaction record into a policy evaluation context.
 * Safe defaults for any missing fields.
 */
export function buildSimulationContext(tx = {}) {
  return {
    amount:                  Number(tx.amount) || 0,
    currency:                tx.currency        || 'KSH',
    txType:                  tx.txType          || tx.type || 'sendMoney',
    txRef:                   tx.txRef           || tx.id   || '',
    fromPhone:               tx.fromPhone       || tx.from  || '',
    toPhone:                 tx.toPhone         || tx.to    || tx.recipient || '',
    userId:                  tx.userId          || tx.owner || '',

    // Risk signals — caller-supplied or safe defaults
    velocitySpike:           Number(tx.velocitySpike)   || 0,
    deviceTrust:             tx.deviceTrust != null ? Number(tx.deviceTrust) : 0.5,
    geoAnomaly:              Boolean(tx.geoAnomaly),
    impossibleTravel:        Boolean(tx.impossibleTravel),
    simSwap:                 Boolean(tx.simSwap),
    vpnProxy:                Boolean(tx.vpnProxy),
    timeOfDayRisk:           tx.timeOfDayRisk != null ? Number(tx.timeOfDayRisk) : 0.1,

    merchantTrust:           tx.merchantTrust  != null ? Number(tx.merchantTrust)  : 70,
    recipientTrust:          tx.recipientTrust != null ? Number(tx.recipientTrust) : 70,
    isNewRecipient:          Boolean(tx.isNewRecipient),

    failedAuthAttempts:      Number(tx.failedAuthAttempts) || 0,
    fraudReputation:         Number(tx.fraudReputation)    || 0,
    txFrequency:             Number(tx.txFrequency)        || 0,
    sharedThreatScore:       Number(tx.sharedThreatScore)  || 0,
    fraudGraphRisk:          Number(tx.fraudGraphRisk)     || 0,

    webhookAnomaly:          Boolean(tx.webhookAnomaly),
    settlementInconsistency: Boolean(tx.settlementInconsistency),
    queueAnomaly:            Boolean(tx.queueAnomaly),

    correlationId:           generateCorrelationId('sim'),
    timestamp:               tx.createdAt || tx.timestamp || new Date().toISOString(),
    _dryRun:                 true,
  };
}

// ── Single-policy dry-run ──────────────────────────────────────────────────────

export function simulatePolicy(policy, context) {
  const ctx    = { ...context, _dryRun: true };
  const result = evaluatePolicySafe(policy, ctx);
  return { ...result, isDryRun: true, simulatedAt: new Date().toISOString() };
}

// ── All-policies dry-run against one context ───────────────────────────────────

export function runDryRun(context, policies = null) {
  const policiesToUse = policies || getEnabledPolicies();
  const ctx           = { ...context, _dryRun: true };
  const t0            = performance.now();

  const results    = policiesToUse.map(p => evaluatePolicySafe(p, ctx));
  const triggered  = results.filter(r => r.triggered);
  const actionSets = triggered.map(r => r.actions || []);

  const aggregatedActions  = resolveActions(actionSets);
  const finalEffect        = resolveEffect(triggered);
  const simulationLatencyMs = Math.round(performance.now() - t0);

  return {
    correlationId:         generateCorrelationId('dry'),
    isDryRun:              true,
    simulatedAt:           new Date().toISOString(),
    totalPoliciesEvaluated: policiesToUse.length,
    triggeredCount:        triggered.length,
    triggered: triggered.map(r => ({
      policyId:   r.policyId,
      policyName: r.policyName,
      severity:   r.severity,
      effect:     r.effect,
      actions:    r.actions,
    })),
    aggregatedActions,
    finalEffect,
    simulationLatencyMs,
  };
}

// ── Historical transaction replay ──────────────────────────────────────────────

/**
 * Run the current (or provided) policies against an array of historical
 * transaction objects. Returns per-transaction outcomes plus aggregate stats.
 *
 * @param {object[]} transactions  — array of transaction-like objects
 * @param {object[]} [policies]    — policies to test; defaults to enabled policies
 * @returns {{ results, stats }}
 */
export function replayTransactions(transactions, policies = null) {
  const policiesToUse = policies || getEnabledPolicies();

  const results = transactions.map(tx => {
    const ctx    = buildSimulationContext(tx);
    const batch  = policiesToUse.map(p => evaluatePolicySafe(p, ctx));
    const hit    = batch.filter(r => r.triggered);
    const effect = resolveEffect(hit);
    const actions = resolveActions(hit.map(r => r.actions || []));

    return {
      txRef:            tx.txRef || tx.id,
      originalOutcome:  tx.outcome || 'unknown',
      simulatedEffect:  effect,
      triggeredCount:   hit.length,
      triggeredPolicies: hit.map(r => r.policyId),
      aggregatedActions: actions,
    };
  });

  const totals = results.reduce(
    (acc, r) => {
      acc[r.simulatedEffect] = (acc[r.simulatedEffect] || 0) + 1;
      return acc;
    },
    { DENY: 0, ESCALATE: 0, REVIEW: 0, ALLOW: 0 }
  );

  const n = results.length || 1;

  return {
    replayedAt:       new Date().toISOString(),
    totalTransactions: results.length,
    effectBreakdown:  totals,
    denialRate:       ((totals.DENY     / n) * 100).toFixed(2) + '%',
    escalationRate:   ((totals.ESCALATE / n) * 100).toFixed(2) + '%',
    results,
  };
}

// ── A/B scenario comparison ────────────────────────────────────────────────────

/**
 * Compare the policy engine outcome for two different contexts.
 * Useful for: "what changes if I lower this threshold from X to Y?"
 *
 * @param {object} contextA
 * @param {object} contextB
 * @param {string} [label]
 * @param {object[]} [policies]
 */
export function compareScenarios(contextA, contextB, label = '', policies = null) {
  const policiesToUse = policies || getEnabledPolicies();

  const evalContext = ctx => {
    const batch     = policiesToUse.map(p => evaluatePolicySafe(p, { ...ctx, _dryRun: true }));
    const triggered = batch.filter(r => r.triggered);
    return {
      effect:         resolveEffect(triggered),
      actions:        resolveActions(triggered.map(r => r.actions || [])),
      triggeredCount: triggered.length,
      triggeredIds:   triggered.map(r => r.policyId),
    };
  };

  const resultA = evalContext(contextA);
  const resultB = evalContext(contextB);

  return {
    label,
    comparedAt:    new Date().toISOString(),
    scenarioA:     resultA,
    scenarioB:     resultB,
    effectChanged: resultA.effect !== resultB.effect,
    actionsDiff: {
      added:   resultB.actions.filter(a => !resultA.actions.includes(a)),
      removed: resultA.actions.filter(a => !resultB.actions.includes(a)),
    },
    policiesDiff: {
      added:   resultB.triggeredIds.filter(id => !resultA.triggeredIds.includes(id)),
      removed: resultA.triggeredIds.filter(id => !resultB.triggeredIds.includes(id)),
    },
  };
}

// ── False-positive estimation ──────────────────────────────────────────────────

/**
 * Run a single policy against an array of known-legitimate transactions.
 * Transactions without isLegitimate = false are treated as legitimate.
 *
 * @param {object}   policy
 * @param {object[]} sampleTransactions
 */
export function estimateFalsePositives(policy, sampleTransactions) {
  const legitimate = sampleTransactions.filter(tx => tx.isLegitimate !== false);

  const falsePositives = legitimate.filter(tx => {
    const ctx    = buildSimulationContext(tx);
    const result = evaluatePolicySafe(policy, ctx);
    return result.triggered;
  });

  const n   = legitimate.length || 1;
  const fps = falsePositives.length;

  return {
    policyId:           policy.id,
    policyName:         policy.name,
    sampleSize:         legitimate.length,
    falsePositiveCount: fps,
    falsePositiveRate:  ((fps / n) * 100).toFixed(2) + '%',
    estimatedAt:        new Date().toISOString(),
    samples: falsePositives.slice(0, 10).map(tx => ({
      txRef:  tx.txRef || tx.id,
      amount: tx.amount,
    })),
  };
}

// ── Attack simulation ──────────────────────────────────────────────────────────

/**
 * Test whether known fraud attack patterns are correctly blocked.
 * Returns a detection scorecard.
 */
export function simulateFraudAttacks(policies = null) {
  const policiesToUse = policies || getEnabledPolicies();

  const ATTACK_SCENARIOS = [
    { name: 'SIM swap transfer', simSwap: true,  amount: 5000,  deviceTrust: 0.1 },
    { name: 'High-velocity burst',  velocitySpike: 10, amount: 20000 },
    { name: 'Impossible travel',    impossibleTravel: true, amount: 30000 },
    { name: 'New recipient large',  isNewRecipient: true, amount: 80000, deviceTrust: 0.2 },
    { name: 'Critical reputation',  fraudReputation: 90, recipientTrust: 5, amount: 10000 },
    { name: 'Shared threat cluster', sharedThreatScore: 80, amount: 15000 },
    { name: 'Night-time large tx',  timeOfDayRisk: 0.9, amount: 25000 },
    { name: 'VPN high value',       vpnProxy: true, amount: 50000 },
    { name: 'Brute-force auth',     failedAuthAttempts: 5, amount: 1000 },
    { name: 'Fraud graph flagged',  fraudGraphRisk: 80, amount: 5000 },
  ];

  const results = ATTACK_SCENARIOS.map(scenario => {
    const ctx    = buildSimulationContext(scenario);
    const batch  = policiesToUse.map(p => evaluatePolicySafe(p, ctx));
    const hit    = batch.filter(r => r.triggered);
    const effect = resolveEffect(hit);

    return {
      scenario:   scenario.name,
      detected:   effect === 'DENY' || effect === 'ESCALATE' || effect === 'REVIEW',
      effect,
      triggeredPolicies: hit.map(r => r.policyId),
    };
  });

  const detected = results.filter(r => r.detected).length;
  const total    = results.length;

  return {
    simulatedAt:     new Date().toISOString(),
    totalScenarios:  total,
    detected,
    missed:          total - detected,
    detectionRate:   ((detected / total) * 100).toFixed(1) + '%',
    results,
  };
}

// ── Summary report ─────────────────────────────────────────────────────────────

export function generateSimulationReport(runResults) {
  const arr      = Array.isArray(runResults) ? runResults : [];
  const triggers = arr.filter(r => (r.triggeredCount || 0) > 0 || r.triggered);

  const byEffect = arr.reduce((acc, r) => {
    const e = r.finalEffect || r.effect || 'UNKNOWN';
    acc[e]  = (acc[e] || 0) + 1;
    return acc;
  }, {});

  return {
    reportedAt:       new Date().toISOString(),
    totalSimulations: arr.length,
    triggeredCount:   triggers.length,
    triggerRate:      arr.length > 0
      ? ((triggers.length / arr.length) * 100).toFixed(2) + '%'
      : '0.00%',
    effectBreakdown:  byEffect,
  };
}
