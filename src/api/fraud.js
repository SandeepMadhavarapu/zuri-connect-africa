/**
 * Zuri Connect Africa — Fraud API Layer
 */

import { invokeLlm } from '@/services/aiService.js';
import { obs, METRICS } from '@/lib/observability';
import { emit, EVENTS } from '@/lib/eventBus';
import { audit, SEVERITY } from '@/lib/auditLogger';
import { getAuditLog } from '@/lib/auditLogger';
import { flagSuspiciousDevice } from '@/lib/deviceTrust';

export async function analyzeMessage(message, userId) {
  const trace = obs.startTrace('fraud.analyzeMessage');
  try {
    obs.info('fraud.analyzeMessage', { userId, length: message?.length });
    const result = await invokeLlm({
      prompt: `You are a M-PESA fraud detection system for Kenya. Analyze this message for fraud signals. Return JSON.
Message: "${message}"
Return: { isFraud: boolean, confidence: number (0-1), signals: string[], severity: "low"|"medium"|"high"|"critical", recommendation: string }`,
      response_json_schema: {
        type: 'object',
        properties: {
          isFraud: { type: 'boolean' },
          confidence: { type: 'number' },
          signals: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string' },
          recommendation: { type: 'string' },
        },
      },
    });

    if (result.isFraud) {
      obs.track(METRICS.FRAUD_TRIGGER_COUNT, 1, { severity: result.severity });
      emit(EVENTS.FRAUD_FLAGGED, { userId, confidence: result.confidence, signals: result.signals });
      audit.fraudEscalated(userId, null, { signals: result.signals, confidence: result.confidence });
    }

    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('fraud.analyzeMessage failed', { error: err.message });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

export async function flagTransaction(txRef, userId, reason, deviceId) {
  const trace = obs.startTrace('fraud.flagTransaction');
  try {
    obs.warn('fraud.flagTransaction', { txRef, userId, reason });
    obs.track(METRICS.FRAUD_TRIGGER_COUNT, 1, { type: 'manual_flag' });

    audit.fraudEscalated(userId, txRef, { reason, flaggedBy: userId });
    emit(EVENTS.FRAUD_FLAGGED, { txRef, userId, reason });

    if (deviceId) flagSuspiciousDevice(deviceId, reason);

    obs.endTrace(trace.traceId);
    return { flagged: true, txRef, reason };
  } catch (err) {
    obs.error('fraud.flagTransaction failed', { error: err.message, txRef });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

export function getFraudAlerts(limit = 50) {
  const log = getAuditLog({ limit });
  return log
    .filter(e => e.severity === SEVERITY.HIGH || e.severity === SEVERITY.CRITICAL)
    .sort((a, b) => b.epochMs - a.epochMs)
    .slice(0, limit);
}
