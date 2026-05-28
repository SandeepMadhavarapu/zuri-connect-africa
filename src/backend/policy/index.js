/**
 * Policy Engine — Public surface.
 *
 * Import from here, not from individual sub-modules, to keep call-site
 * coupling minimal and allow internal refactoring without breaking consumers.
 */

// ── Primary evaluation API ────────────────────────────────────────────────────
export {
  getPolicyDecision,
  evaluatePolicies,
  buildPolicyContext,
} from './policyEngine.js';

// ── Registry management ───────────────────────────────────────────────────────
export {
  getAllPolicies,
  getEnabledPolicies,
  getPolicyById,
  isBuiltInPolicy,
  createPolicy,
  updatePolicy,
  deletePolicy,
  enablePolicy,
  disablePolicy,
  setRolloutPercentage,
  getFeatureFlags,
  updateFeatureFlags,
  emergencyDisableAll,
  emergencyEnableAll,
  enableDryRunMode,
  disableDryRunMode,
  getPolicyHistory,
  exportPolicies,
  importPolicies,
  resetToDefaults,
} from './policyRegistry.js';

// ── Audit trail ───────────────────────────────────────────────────────────────
export {
  getPolicyAuditLog,
  getPolicyAuditStats,
  verifyPolicyAuditIntegrity,
  exportPolicyAuditLog,
  appendPolicyChangeAudit,
  appendEmergencyAudit,
} from './policyAudit.js';

// ── Observability / metrics ───────────────────────────────────────────────────
export {
  getEngineMetrics,
  getPolicyMetrics,
  getTopTriggeredPolicies,
  generatePolicyDiagnosticsReport,
  generateCorrelationId,
  resetPolicyMetrics,
} from './policyMetrics.js';

// ── Simulator ─────────────────────────────────────────────────────────────────
export {
  runDryRun,
  simulatePolicy,
  replayTransactions,
  compareScenarios,
  estimateFalsePositives,
  simulateFraudAttacks,
  buildSimulationContext,
  generateSimulationReport,
} from './policySimulator.js';

// ── Schema / constants ────────────────────────────────────────────────────────
export {
  POLICY_OPERATORS,
  CONDITION_GROUP_OPERATORS,
  SEVERITY_LEVELS,
  SEVERITY_SCORE_MAP,
  POLICY_EFFECTS,
  EFFECT_PRECEDENCE,
  POLICY_ACTIONS,
  CONDITION_FIELDS,
  validatePolicy,
  validatePolicyConditions,
  createPolicyTemplate,
} from './policySchemas.js';
