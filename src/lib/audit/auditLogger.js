import * as auditService from '@/services/auditService.js';

function genCorrelationId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `cid_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const CATEGORY = {
  AUTH: 'auth',
  FINANCIAL: 'financial',
  FRAUD: 'fraud',
  ADMIN: 'admin',
  SECURITY: 'security',
  SYSTEM: 'system',
  COMPLIANCE: 'compliance',
};

const SEVERITY = {
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  CRITICAL: 'critical',
};

export const AUDIT_CATEGORY = CATEGORY;
export const AUDIT_SEVERITY = SEVERITY;

function baseEvent(category, severity = SEVERITY.INFO) {
  return {
    category,
    severity,
    correlationId: genCorrelationId(),
    actorIp: typeof window !== 'undefined' ? null : null,
  };
}

/**
 * Fire-and-forget event writer with structured contract.
 */
export async function logEvent(eventType, category, action, payload = {}, opts = {}) {
  const base = baseEvent(category, opts.severity);
  const ev = {
    ...base,
    eventType,
    action,
    actorId: opts.actorId,
    actorType: opts.actorType || 'user',
    targetType: opts.targetType,
    targetId: opts.targetId,
    outcome: opts.outcome || 'success',
    payload,
    correlationId: opts.correlationId || base.correlationId,
    sessionId: opts.sessionId,
  };
  return auditService.persistAuditEvent(ev).catch(() => null);
}

export const auditAuth = (action, payload, opts) =>
  logEvent(`auth.${action}`, CATEGORY.AUTH, action, payload, opts);

export const auditFinancial = (action, payload, opts) =>
  logEvent(`financial.${action}`, CATEGORY.FINANCIAL, action, payload, opts);

export const auditFraud = (action, payload, opts) =>
  logEvent(`fraud.${action}`, CATEGORY.FRAUD, action, payload, { severity: 'warn', ...opts });

export const auditAdmin = (action, payload, opts) =>
  logEvent(`admin.${action}`, CATEGORY.ADMIN, action, payload, opts);

export const auditSecurity = (action, payload, opts) =>
  logEvent(`security.${action}`, CATEGORY.SECURITY, action, payload, { severity: 'warn', ...opts });

export const auditCritical = (eventType, action, payload, opts) =>
  logEvent(eventType, CATEGORY.SECURITY, action, payload, { severity: 'critical', ...opts });

export async function verifyChain(startSeq, endSeq) {
  return auditService.verifyAuditChain(startSeq, endSeq);
}
