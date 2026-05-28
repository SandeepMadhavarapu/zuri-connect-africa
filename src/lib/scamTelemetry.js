/**
 * Zuri Connect Africa — Scam Telemetry
 * Telecom-style fraud telemetry infrastructure.
 * Raw scores are NEVER stored or exposed publicly.
 */

import { recordThreatSignal } from '@/backend/fraud/threatIntel';

const STORAGE_KEY = '_zca_telemetry';
const MAX_EVENTS = 100;

function _load() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { events: [] };
  } catch {
    return { events: [] };
  }
}

function _save(store) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {}
}

/**
 * Log a scam attempt or interception event.
 * @param {object} params
 */
export function logScamAttempt({
  eventType,         // 'fraud_warning' | 'fraud_blocked' | 'auth_escalated' | 'suspicious_recipient'
  scamCategory,      // 'lottery' | 'urgency' | 'reversal' | 'impersonation' | 'velocity' | 'device' | 'graph' | 'generic'
  triggeredSignals,  // string[]
  userAction,        // 'proceeded' | 'cancelled' | 'blocked'
  recipientPhoneHash, // hashed for privacy
  amountBand,        // '<500' | '500-2k' | '2k-10k' | '10k+' — not exact amount
  deviceAnomalyFlag, // boolean
  authEscalated,     // boolean
  timestamp = Date.now(),
}) {
  const store = _load();

  store.events.unshift({
    eventType,
    scamCategory,
    triggeredSignals: triggeredSignals || [],
    userAction,
    recipientPhoneHash: recipientPhoneHash || null,
    amountBand: amountBand || 'unknown',
    deviceAnomalyFlag: !!deviceAnomalyFlag,
    authEscalated: !!authEscalated,
    timestamp,
  });

  // Keep ring buffer bounded
  if (store.events.length > MAX_EVENTS) {
    store.events = store.events.slice(0, MAX_EVENTS);
  }

  _save(store);

  if (eventType === 'fraud_warning' || eventType === 'fraud_blocked' || eventType === 'suspicious_recipient') {
    recordThreatSignal({
      userId: 'local_user',
      recipient: recipientPhoneHash,
      txPattern: scamCategory,
      amount: amountBand,
      source: eventType,
      confidence: eventType === 'fraud_blocked' ? 0.9 : 0.65,
    });
  }
}

/**
 * Get recent threat events for display (natural language only, no scores).
 * @param {number} limit
 * @returns {Array}
 */
export function getRecentThreats(limit = 20) {
  const store = _load();
  return store.events.slice(0, limit).map(e => ({
    eventType: e.eventType,
    scamCategory: e.scamCategory,
    triggeredSignals: e.triggeredSignals,
    userAction: e.userAction,
    amountBand: e.amountBand,
    authEscalated: e.authEscalated,
    timestamp: e.timestamp,
  }));
}

/**
 * Get aggregated scam pattern statistics (no scores, counts only).
 * @returns {object}
 */
export function getTopScamPatterns() {
  const store = _load();
  const events = store.events;

  const categoryCounts = {};
  const signalCounts = {};
  let blocked = 0;
  let warned = 0;
  let proceeded = 0;
  let cancelled = 0;
  let authEscalated = 0;

  for (const e of events) {
    // Category tally
    if (e.scamCategory) {
      categoryCounts[e.scamCategory] = (categoryCounts[e.scamCategory] || 0) + 1;
    }
    // Signal tally
    for (const sig of (e.triggeredSignals || [])) {
      signalCounts[sig] = (signalCounts[sig] || 0) + 1;
    }
    if (e.eventType === 'fraud_blocked') blocked++;
    if (e.eventType === 'fraud_warning') warned++;
    if (e.userAction === 'proceeded') proceeded++;
    if (e.userAction === 'cancelled') cancelled++;
    if (e.authEscalated) authEscalated++;
  }

  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const topSignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([signal, count]) => ({ signal, count }));

  return {
    totalEvents: events.length,
    blocked,
    warned,
    proceeded,
    cancelled,
    authEscalated,
    topCategories,
    topSignals,
  };
}

/**
 * Derive an amount band label from a numeric amount.
 */
export function getAmountBand(amount) {
  if (amount < 500) return '<500';
  if (amount < 2000) return '500-2k';
  if (amount < 10000) return '2k-10k';
  return '10k+';
}

/**
 * Simple one-way phone hash for telemetry (not reversible).
 */
export function hashPhone(phone) {
  if (!phone) return null;
  let hash = 0;
  const str = phone.replace(/\D/g, '');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return `ph_${Math.abs(hash).toString(36)}`;
}
