/**
 * Append-only webhook audit trail.
 * Entries are never updated in place; state transitions append new records.
 */

const AUDIT_KEY = 'zuri_webhook_audit_v1';
const MAX_AUDIT_ENTRIES = 1000;

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]');
  } catch {
    return [];
  }
}

function writeStore(entries) {
  try {
    localStorage.setItem(AUDIT_KEY, JSON.stringify(entries));
  } catch {
    // Console output remains the operational fallback if local storage is full.
  }
}

function chainHash(entry) {
  const raw = JSON.stringify({
    id: entry.id,
    webhookId: entry.webhookId,
    txRef: entry.txRef,
    event: entry.event,
    timestamp: entry.timestamp,
    previousHash: entry.previousHash,
  });

  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  const sensitive = ['authorization', 'password', 'pin', 'secret', 'signature', 'token'];
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
    if (sensitive.some(s => key.toLowerCase().includes(s))) return [key, '[REDACTED]'];
    return [key, redact(nested)];
  }));
}

export function logWebhookAudit(event, details = {}) {
  const entries = readStore();
  const previous = entries[entries.length - 1];
  const entry = {
    id: `wh_audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    event,
    webhookId: details.webhookId || null,
    txRef: details.txRef || null,
    correlationId: details.correlationId || null,
    sourceIp: details.sourceIp || null,
    signatureValid: details.signatureValid ?? null,
    replayAttempt: Boolean(details.replayAttempt),
    processingDurationMs: details.processingDurationMs ?? null,
    retryCount: details.retryCount ?? 0,
    queueStatus: details.queueStatus || null,
    settlementOutcome: details.settlementOutcome || null,
    timestamp: new Date().toISOString(),
    epochMs: Date.now(),
    details: redact(details),
    previousHash: previous?.hash || '00000000',
  };
  entry.hash = chainHash(entry);

  entries.push(entry);
  if (entries.length > MAX_AUDIT_ENTRIES) {
    entries.splice(0, entries.length - MAX_AUDIT_ENTRIES);
  }
  writeStore(entries);

  console.info('[WebhookAudit]', JSON.stringify(entry));
  return entry;
}

export function getWebhookAuditLog({ webhookId, txRef, limit = 250 } = {}) {
  return readStore()
    .filter(entry => !webhookId || entry.webhookId === webhookId)
    .filter(entry => !txRef || entry.txRef === txRef)
    .slice(-limit);
}

export function verifyWebhookAuditIntegrity() {
  const entries = readStore();
  for (let i = 0; i < entries.length; i++) {
    const expectedHash = chainHash(entries[i]);
    if (entries[i].hash !== expectedHash) {
      return { valid: false, brokenAt: i, reason: 'entry_hash_mismatch' };
    }
    if (i > 0 && entries[i].previousHash !== entries[i - 1].hash) {
      return { valid: false, brokenAt: i, reason: 'audit_chain_broken' };
    }
  }
  return { valid: true, entriesChecked: entries.length };
}
