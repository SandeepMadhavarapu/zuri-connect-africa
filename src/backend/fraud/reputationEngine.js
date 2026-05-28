/**
 * Fraud reputation engine for recipients, merchants, and devices.
 */

const REPUTATION_KEY = 'zuri_fraud_reputation_v1';

function readReputation() {
  try {
    return JSON.parse(localStorage.getItem(REPUTATION_KEY) || '{"recipients":{},"merchants":{},"devices":{},"transactions":{}}');
  } catch {
    return { recipients: {}, merchants: {}, devices: {}, transactions: {} };
  }
}

function writeReputation(store) {
  try {
    localStorage.setItem(REPUTATION_KEY, JSON.stringify(store));
  } catch {}
}

function key(value) {
  return String(value || 'unknown').toLowerCase();
}

function ensureRecord(store, bucket, id) {
  const recordKey = key(id);
  store[bucket][recordKey] = store[bucket][recordKey] || {
    id: recordKey,
    trustScore: 70,
    riskScore: 0,
    successfulTx: 0,
    failedTx: 0,
    disputeCount: 0,
    scamReports: 0,
    authFailures: 0,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    velocity: [],
    flags: [],
  };
  return store[bucket][recordKey];
}

function recalculate(record) {
  const failurePenalty = record.failedTx * 8;
  const disputePenalty = record.disputeCount * 18;
  const scamPenalty = record.scamReports * 28;
  const authPenalty = record.authFailures * 5;
  const successCredit = Math.min(25, record.successfulTx * 3);
  const velocityPenalty = record.velocity.filter(ts => ts > Date.now() - 10 * 60 * 1000).length > 4 ? 15 : 0;

  record.riskScore = Math.min(100, failurePenalty + disputePenalty + scamPenalty + authPenalty + velocityPenalty);
  record.trustScore = Math.max(0, Math.min(100, 70 + successCredit - record.riskScore));

  if (record.riskScore >= 70 && !record.flags.includes('high_risk_reputation')) {
    record.flags.push('high_risk_reputation');
  }
  if (velocityPenalty && !record.flags.includes('high_velocity')) record.flags.push('high_velocity');
  return record;
}

export function updateFraudReputation({
  recipient,
  merchant,
  deviceId,
  txRef,
  outcome = 'success',
  amount = 0,
  scamReport = false,
  dispute = false,
  authFailure = false,
} = {}) {
  const store = readReputation();
  const buckets = [
    recipient ? ['recipients', recipient] : null,
    merchant ? ['merchants', merchant] : null,
    deviceId ? ['devices', deviceId] : null,
    txRef ? ['transactions', txRef] : null,
  ].filter(Boolean);

  const updated = buckets.map(([bucket, id]) => {
    const record = ensureRecord(store, bucket, id);
    record.lastSeenAt = Date.now();
    record.velocity.push(Date.now());
    record.velocity = record.velocity.filter(ts => ts > Date.now() - 60 * 60 * 1000);
    record.lastAmount = amount;

    if (outcome === 'success') record.successfulTx += 1;
    if (outcome === 'failed') record.failedTx += 1;
    if (scamReport) record.scamReports += 1;
    if (dispute) record.disputeCount += 1;
    if (authFailure) record.authFailures += 1;

    return recalculate(record);
  });

  writeReputation(store);
  return updated;
}

export function evaluateCounterpartyReputation({ recipient, merchant, deviceId } = {}) {
  const store = readReputation();
  const records = [
    recipient ? store.recipients[key(recipient)] : null,
    merchant ? store.merchants[key(merchant)] : null,
    deviceId ? store.devices[key(deviceId)] : null,
  ].filter(Boolean);

  if (!records.length) {
    return { known: false, trustScore: 50, riskScore: 15, flags: ['new_counterparty'] };
  }

  const riskScore = Math.max(...records.map(record => record.riskScore || 0));
  const trustScore = Math.min(...records.map(record => record.trustScore ?? 50));
  const flags = Array.from(new Set(records.flatMap(record => record.flags || [])));

  return {
    known: true,
    trustScore,
    riskScore,
    flags,
    records,
  };
}

export function getReputationSnapshot() {
  const store = readReputation();
  const highRiskRecipients = Object.values(store.recipients).filter(record => record.riskScore >= 70);
  const riskyMerchants = Object.values(store.merchants).filter(record => record.riskScore >= 60);

  return {
    recipients: Object.values(store.recipients).sort((a, b) => b.riskScore - a.riskScore).slice(0, 50),
    merchants: Object.values(store.merchants).sort((a, b) => b.riskScore - a.riskScore).slice(0, 50),
    devices: Object.values(store.devices).sort((a, b) => b.riskScore - a.riskScore).slice(0, 50),
    highRiskRecipientCount: highRiskRecipients.length,
    riskyMerchantCount: riskyMerchants.length,
    updatedAt: Date.now(),
  };
}
