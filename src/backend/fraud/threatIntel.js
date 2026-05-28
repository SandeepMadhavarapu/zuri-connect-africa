/**
 * Shared threat intelligence.
 * Aggregates similar scam messages, recipients, merchants, and payment patterns.
 */

const THREAT_KEY = 'zuri_shared_threat_intel_v1';
const MAX_SIGNALS = 1000;

function readThreats() {
  try {
    return JSON.parse(localStorage.getItem(THREAT_KEY) || '{"signals":[],"clusters":{}}');
  } catch {
    return { signals: [], clusters: {} };
  }
}

function writeThreats(store) {
  try {
    localStorage.setItem(THREAT_KEY, JSON.stringify(store));
  } catch {}
}

function normaliseText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b\d{4,}\b/g, '#')
    .replace(/[^\w\s#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function clusterKey({ message, recipient, merchant, pattern }) {
  if (message) return `msg:${normaliseText(message)}`;
  if (recipient) return `recipient:${String(recipient).toLowerCase()}`;
  if (merchant) return `merchant:${String(merchant).toLowerCase()}`;
  return `pattern:${normaliseText(pattern || 'unknown')}`;
}

export function recordThreatSignal({
  userId = 'anonymous',
  message,
  recipient,
  merchant,
  txPattern,
  amount,
  source = 'user_report',
  confidence = 0.5,
} = {}) {
  const store = readThreats();
  const key = clusterKey({ message, recipient, merchant, pattern: txPattern });
  const now = Date.now();

  const cluster = store.clusters[key] || {
    key,
    source,
    firstSeenAt: now,
    lastSeenAt: now,
    userCount: 0,
    signalCount: 0,
    confidence: 0,
    globalRisk: 0,
    sample: { message: normaliseText(message), recipient, merchant, txPattern },
    affectedUsers: [],
    amounts: [],
  };

  if (!cluster.affectedUsers.includes(userId)) cluster.affectedUsers.push(userId);
  cluster.userCount = cluster.affectedUsers.length;
  cluster.signalCount += 1;
  cluster.lastSeenAt = now;
  cluster.confidence = Math.min(1, Math.max(cluster.confidence, confidence));
  if (Number.isFinite(amount)) cluster.amounts.push(Number(amount));
  cluster.amounts = cluster.amounts.slice(-25);
  cluster.globalRisk = Math.min(100, Math.round(
    cluster.signalCount * 12 +
    cluster.userCount * 18 +
    cluster.confidence * 25
  ));

  store.clusters[key] = cluster;
  store.signals.push({
    id: `ti_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key,
    userId,
    messageHash: message ? normaliseText(message) : null,
    recipient: recipient || null,
    merchant: merchant || null,
    txPattern: txPattern || null,
    amount: amount || null,
    source,
    confidence,
    createdAt: now,
  });

  if (store.signals.length > MAX_SIGNALS) {
    store.signals.splice(0, store.signals.length - MAX_SIGNALS);
  }

  writeThreats(store);
  return cluster;
}

export function evaluateSharedThreat({ message, recipient, merchant, txPattern, amount } = {}) {
  const store = readThreats();
  const candidates = [
    clusterKey({ message }),
    clusterKey({ recipient }),
    clusterKey({ merchant }),
    clusterKey({ pattern: txPattern }),
  ].filter(key => !key.endsWith('unknown'));

  const matched = candidates
    .map(key => store.clusters[key])
    .filter(Boolean)
    .sort((a, b) => b.globalRisk - a.globalRisk);

  const top = matched[0];
  if (!top) {
    return { matched: false, globalRisk: 0, sensitivityBump: 0, warnings: [] };
  }

  const amountNearCluster = Number.isFinite(amount) && top.amounts?.length
    ? top.amounts.some(value => Math.abs(value - amount) <= Math.max(100, value * 0.1))
    : false;

  const globalRisk = Math.min(100, top.globalRisk + (amountNearCluster ? 10 : 0));
  return {
    matched: true,
    globalRisk,
    sensitivityBump: globalRisk >= 70 ? 25 : globalRisk >= 45 ? 12 : 5,
    warnings: [
      globalRisk >= 70 ? 'shared_threat_cluster_high' : 'shared_threat_cluster_observed',
    ],
    cluster: top,
  };
}

export function getThreatIntelSnapshot() {
  const store = readThreats();
  return {
    signals: store.signals.slice(-100),
    clusters: Object.values(store.clusters)
      .sort((a, b) => b.globalRisk - a.globalRisk)
      .slice(0, 50),
    highRiskClusters: Object.values(store.clusters).filter(cluster => cluster.globalRisk >= 70).length,
    updatedAt: Date.now(),
  };
}
