/**
 * Fraud Intelligence Service — distributed fraud detection for Zuri Connect Africa.
 *
 * Aggregates signals from multiple detection layers into a unified risk verdict:
 *   1. Velocity analysis (rolling windows: 1m / 10m / 1h / 24h)
 *   2. Fraud graph traversal (2-hop community risk propagation)
 *   3. Behavioural baseline deviation (amount, time, recipient patterns)
 *   4. Device + SIM risk (delegates to deviceTrust / simSwapDetector)
 *   5. Shared threat cluster membership
 *   6. Policy engine decision (delegates to policyEngine)
 *
 * Output shape is backwards-compatible with adaptiveEscalation output so
 * existing payment flows need zero changes.
 *
 * Storage:
 *   localStorage 'zuri_fraud_intelligence_v1' — per-user baseline profiles
 *   localStorage 'zuri_fraud_graph_v1'         — existing fraud graph (shared)
 */

import { recordOperation, SERVICES, traced } from '@/server/domain/observability/telemetryService';
import { evaluateAdaptiveFraudEscalation }   from '@/backend/fraud/adaptiveEscalation';
import { evaluateCounterpartyReputation }    from '@/backend/fraud/reputationEngine';
import { evaluateSharedThreat }              from '@/backend/fraud/threatIntel';
import { evaluateDeviceRisk }                from '@/lib/deviceTrust';
import { getPolicyDecision }                 from '@/backend/policy/policyEngine';

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_PROFILES  = 'zuri_fraud_intelligence_v1';
const GRAPH_KEY    = 'zuri_fraud_graph_v1';

// Velocity windows
const WINDOWS = {
  ONE_MIN:    1  * 60 * 1000,
  TEN_MIN:   10  * 60 * 1000,
  ONE_HOUR:  60  * 60 * 1000,
  ONE_DAY:  24  * 60  * 60 * 1000,
};

// Risk score weights (sum = 1.0)
const WEIGHTS = {
  velocity:         0.20,
  graphRisk:        0.15,
  policyDecision:   0.25,
  deviceRisk:       0.15,
  reputationRisk:   0.15,
  behaviouralDrift: 0.10,
};

export const RISK_LEVEL = Object.freeze({
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
});

// ── Storage helpers ───────────────────────────────────────────────────────────

function loadProfiles() {
  try { return JSON.parse(localStorage.getItem(LS_PROFILES) || '{}'); } catch { return {}; }
}

function saveProfiles(profiles) {
  try { localStorage.setItem(LS_PROFILES, JSON.stringify(profiles)); } catch {}
}

function loadGraph() {
  try { return JSON.parse(localStorage.getItem(GRAPH_KEY) || '{"events":[],"nodes":{},"edges":[]}'); }
  catch { return { events: [], nodes: {}, edges: [] }; }
}

// ── Velocity analysis ─────────────────────────────────────────────────────────

function analyseVelocity(fromPhone) {
  try {
    const graph  = loadGraph();
    const events = Array.isArray(graph.events) ? graph.events : [];
    const now    = Date.now();

    const counts = {
      oneMin:   events.filter(e => e.phone === fromPhone && (e.ts || 0) > now - WINDOWS.ONE_MIN).length,
      tenMin:   events.filter(e => e.phone === fromPhone && (e.ts || 0) > now - WINDOWS.TEN_MIN).length,
      oneHour:  events.filter(e => e.phone === fromPhone && (e.ts || 0) > now - WINDOWS.ONE_HOUR).length,
      oneDay:   events.filter(e => e.phone === fromPhone && (e.ts || 0) > now - WINDOWS.ONE_DAY).length,
    };

    // Velocity score: high counts in short windows are more suspicious
    let score = 0;
    if (counts.oneMin  >= 3)  score += 40;
    if (counts.tenMin  >= 8)  score += 30;
    if (counts.oneHour >= 20) score += 20;
    if (counts.oneDay  >= 50) score += 10;

    return {
      counts,
      score:   Math.min(100, score),
      spike:   counts.tenMin,
    };
  } catch { return { counts: {}, score: 0, spike: 0 }; }
}

// ── Fraud graph traversal ─────────────────────────────────────────────────────

function traverseFraudGraph(phone, maxHops = 2) {
  try {
    const graph  = loadGraph();
    const nodes  = graph.nodes || {};
    const edges  = Array.isArray(graph.edges) ? graph.edges : [];

    let communityRisk = 0;
    const visited    = new Set([phone]);
    let frontier     = [phone];

    for (let hop = 0; hop < maxHops; hop++) {
      const nextFrontier = [];
      const decayFactor  = 1 - (hop * 0.4);  // 1.0 at hop 0, 0.6 at hop 1

      for (const node of frontier) {
        const connectedEdges = edges.filter(e => e.from === node || e.to === node);
        for (const edge of connectedEdges) {
          const neighbor = edge.from === node ? edge.to : edge.from;
          if (visited.has(neighbor)) continue;
          visited.add(neighbor);
          nextFrontier.push(neighbor);

          const neighborNode = nodes[neighbor];
          if (neighborNode) {
            const nodeRisk = (neighborNode.riskScore || 0) * decayFactor;
            communityRisk  = Math.max(communityRisk, nodeRisk);
          }
        }
      }
      frontier = nextFrontier;
    }

    const sourceNode = nodes[phone];
    const directRisk = sourceNode?.riskScore || 0;

    return {
      directRisk,
      communityRisk: Math.min(100, communityRisk),
      totalRisk:     Math.min(100, Math.max(directRisk, communityRisk * 0.7)),
      connectedNodes: visited.size - 1,
    };
  } catch { return { directRisk: 0, communityRisk: 0, totalRisk: 0, connectedNodes: 0 }; }
}

// ── Behavioural baseline ──────────────────────────────────────────────────────

function updateBaseline(userId, txData) {
  try {
    const profiles = loadProfiles();
    if (!profiles[userId]) {
      profiles[userId] = {
        avgAmount:       txData.amount,
        maxAmount:       txData.amount,
        txCount:         1,
        knownRecipients: txData.toPhone ? [txData.toPhone] : [],
        typicalHours:    [new Date().getHours()],
        lastUpdated:     Date.now(),
      };
    } else {
      const p = profiles[userId];
      p.txCount++;
      p.avgAmount     = ((p.avgAmount * (p.txCount - 1)) + txData.amount) / p.txCount;
      p.maxAmount     = Math.max(p.maxAmount, txData.amount);
      if (txData.toPhone && !p.knownRecipients.includes(txData.toPhone)) {
        p.knownRecipients = [...p.knownRecipients.slice(-49), txData.toPhone];
      }
      const h = new Date().getHours();
      if (!p.typicalHours.includes(h)) {
        p.typicalHours = [...p.typicalHours.slice(-23), h];
      }
      p.lastUpdated = Date.now();
    }
    saveProfiles(profiles);
    return profiles[userId];
  } catch { return null; }
}

function measureBehaviouralDrift(userId, txData) {
  try {
    const profiles = loadProfiles();
    const p = profiles[userId];
    if (!p || p.txCount < 5) return { score: 0, drift: [] };

    const drift = [];
    let score   = 0;

    // Amount drift
    if (p.avgAmount > 0 && txData.amount > p.avgAmount * 4) {
      const factor = Math.min(3, txData.amount / p.avgAmount);
      score += Math.round(factor * 15);
      drift.push(`amount_${Math.round(factor)}x_avg`);
    }

    // New recipient
    if (txData.toPhone && !p.knownRecipients.includes(txData.toPhone)) {
      score += 15;
      drift.push('new_recipient');
    }

    // Unusual hour
    const h = new Date().getHours();
    if (p.typicalHours.length >= 7 && !p.typicalHours.includes(h) && (h < 5 || h >= 22)) {
      score += 20;
      drift.push('unusual_hour');
    }

    return { score: Math.min(100, score), drift };
  } catch { return { score: 0, drift: [] }; }
}

// ── Main fraud assessment ─────────────────────────────────────────────────────

/**
 * Full fraud intelligence assessment for a transaction.
 *
 * Returns a unified verdict that:
 *   • Is backwards-compatible with adaptiveEscalation output shape
 *   • Includes extended intelligence signals for the policy engine
 *   • NEVER throws (returns a passthrough allow on any error)
 *
 * @param {object} txData       — { amount, fromPhone, toPhone, txType, txRef, userId, ... }
 * @param {object} authContext  — optional auth signal overrides
 * @returns {object} verdict
 */
export async function assessFraudRisk(txData = {}, authContext = {}) {
  const t0 = performance.now();

  return traced(SERVICES.FRAUD, 'assessFraudRisk', async () => {
    try {
      const { amount = 0, fromPhone = '', toPhone = '', userId = '', txRef = '' } = txData;

      // ── Parallel signal collection (all wrapped in try/catch) ──
      const [
        velocityResult,
        graphResult,
        reputationResult,
        threatResult,
        deviceResult,
        behaviouralResult,
      ] = await Promise.all([
        Promise.resolve(analyseVelocity(fromPhone)).catch(() => ({ score: 0, spike: 0 })),
        Promise.resolve(traverseFraudGraph(fromPhone)).catch(() => ({ totalRisk: 0 })),
        Promise.resolve(evaluateCounterpartyReputation({ recipient: toPhone })).catch(() => ({ trustScore: 70, riskScore: 0, known: true })),
        Promise.resolve(evaluateSharedThreat({ recipient: toPhone, amount })).catch(() => ({ globalRisk: 0 })),
        Promise.resolve(evaluateDeviceRisk()).catch(() => ({ score: 0, trusted: true, signals: [] })),
        Promise.resolve(measureBehaviouralDrift(userId, txData)).catch(() => ({ score: 0, drift: [] })),
      ]);

      // ── Policy engine decision ──
      const policyDecision = await Promise.resolve(
        getPolicyDecision(txData, {
          ...authContext,
          fraudGraphRisk:  graphResult.totalRisk || 0,
          velocitySpike:   velocityResult.spike || 0,
        })
      ).catch(() => ({ finalEffect: 'ALLOW', score: 0, level: 'low' }));

      // ── Legacy adaptiveEscalation (for backwards compat) ──
      const legacyEscalation = await Promise.resolve(
        evaluateAdaptiveFraudEscalation({
          amount,
          recipient:     toPhone,
          txPattern:     { txRef, txType: txData.txType || 'send_money' },
          deviceContext: { trust: deviceResult.trusted ? 'trusted' : 'untrusted' },
          velocity:      velocityResult.spike,
          simSwapSignal: deviceResult.signals?.some(s => s.code === 'sim_swap_indicator'),
        })
      ).catch(() => ({ score: 0, level: 'low', actions: [], holdTransaction: false, settlementDelayMs: 0 }));

      // ── Composite risk score ──
      const deviceRiskScore  = Math.min(100, deviceResult.score || 0);
      const reputationScore  = Math.max(0, 100 - (reputationResult.trustScore || 70));
      const policyScore      = policyDecision.score || 0;

      const compositeScore = Math.round(
        velocityResult.score    * WEIGHTS.velocity         +
        graphResult.totalRisk   * WEIGHTS.graphRisk        +
        policyScore             * WEIGHTS.policyDecision   +
        deviceRiskScore         * WEIGHTS.deviceRisk       +
        reputationScore         * WEIGHTS.reputationRisk   +
        behaviouralResult.score * WEIGHTS.behaviouralDrift
      );

      const level =
        compositeScore >= 80 ? RISK_LEVEL.CRITICAL :
        compositeScore >= 60 ? RISK_LEVEL.HIGH      :
        compositeScore >= 35 ? RISK_LEVEL.MEDIUM    :
                               RISK_LEVEL.LOW;

      // ── Effect resolution (policy wins over legacy if stricter) ──
      const effectPriority = { DENY: 0, ESCALATE: 1, REVIEW: 2, ALLOW: 3 };
      const legacyEffect   = legacyEscalation.level === 'critical' ? 'DENY'
                           : legacyEscalation.level === 'high'     ? 'ESCALATE'
                           : legacyEscalation.level === 'medium'   ? 'REVIEW'
                           : 'ALLOW';
      const policyEffect   = policyDecision.finalEffect || 'ALLOW';

      const finalEffect    = effectPriority[policyEffect] <= effectPriority[legacyEffect]
        ? policyEffect
        : legacyEffect;

      // ── Update baseline (non-blocking) ──
      if (userId) {
        Promise.resolve(updateBaseline(userId, txData)).catch(() => {});
      }

      const latencyMs = Math.round(performance.now() - t0);
      recordOperation(SERVICES.FRAUD, 'assessFraudRisk', latencyMs, true);

      return {
        // ── Core verdict ──
        score:           compositeScore,
        level,
        finalEffect,

        // ── Action requirements ──
        actions:         policyDecision.aggregatedActions || legacyEscalation.actions || [],
        authRequirements: policyDecision.authRequirements || {},
        holdTransaction: finalEffect === 'DENY' || finalEffect === 'ESCALATE' || legacyEscalation.holdTransaction,
        settlementDelayMs: finalEffect === 'DENY' ? 15 * 60 * 1000
                         : finalEffect === 'ESCALATE' ? 5 * 60 * 1000
                         : legacyEscalation.settlementDelayMs || 0,

        // ── Signal breakdown ──
        signals: {
          velocity:     { score: velocityResult.score,    spike: velocityResult.spike,    counts: velocityResult.counts },
          graph:        { score: graphResult.totalRisk,   directRisk: graphResult.directRisk, communityRisk: graphResult.communityRisk },
          device:       { score: deviceRiskScore,         trusted: deviceResult.trusted,   signals: deviceResult.signals || [] },
          reputation:   { score: reputationScore,         trustScore: reputationResult.trustScore, known: reputationResult.known },
          threat:       { score: threatResult.globalRisk, matched: threatResult.matched },
          behavioural:  { score: behaviouralResult.score, drift: behaviouralResult.drift },
          policy: {
            effect:      policyEffect,
            correlation: policyDecision.correlationId,
            triggered:   policyDecision.triggeredCount || 0,
          },
        },

        // ── Backwards compat (legacy callers) ──
        reasons:        [
          ...(policyDecision.reasons || []),
          ...(legacyEscalation.reasons || []),
          ...behaviouralResult.drift,
        ].filter(Boolean),
        throttle:       legacyEscalation.throttle || false,

        // ── Metadata ──
        assessedAt:     new Date().toISOString(),
        latencyMs,
        correlationId:  policyDecision.correlationId,
      };

    } catch (err) {
      recordOperation(SERVICES.FRAUD, 'assessFraudRisk', Math.round(performance.now() - t0), false);
      // Safe passthrough — never block a payment due to fraud engine failure
      return {
        score: 0, level: RISK_LEVEL.LOW, finalEffect: 'ALLOW',
        actions: [], authRequirements: {}, holdTransaction: false,
        settlementDelayMs: 0, signals: {}, reasons: [], throttle: false,
        assessedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - t0),
        passthrough: true, passthroughReason: err?.message || 'assessment_failed',
      };
    }
  });
}

/**
 * Get the stored behavioural baseline profile for a user.
 */
export function getUserProfile(userId) {
  try {
    const profiles = loadProfiles();
    return profiles[userId] || null;
  } catch { return null; }
}

/**
 * Invalidate / reset a user's baseline profile.
 * Use after confirmed fraud or manual analyst override.
 */
export function resetUserProfile(userId) {
  try {
    const profiles = loadProfiles();
    delete profiles[userId];
    saveProfiles(profiles);
    return true;
  } catch { return false; }
}

/**
 * Get aggregate fraud intelligence statistics.
 */
export function getFraudIntelStats() {
  try {
    const profiles   = loadProfiles();
    const graph      = loadGraph();
    const nodeCount  = Object.keys(graph.nodes || {}).length;
    const edgeCount  = (graph.edges || []).length;
    const eventCount = (graph.events || []).length;

    const highRiskNodes = Object.values(graph.nodes || {})
      .filter(n => (n.riskScore || 0) >= 70).length;

    return {
      profiledUsers:   Object.keys(profiles).length,
      graphNodes:      nodeCount,
      graphEdges:      edgeCount,
      recentEvents:    eventCount,
      highRiskNodes,
      generatedAt:     new Date().toISOString(),
    };
  } catch { return {}; }
}
