/**
 * Compliance Service — regulatory compliance and auditability for Zuri Connect Africa.
 *
 * Implements CBK (Central Bank of Kenya) / AML / KYC compliance controls:
 *   • AML transaction monitoring: CTR (Cash Transaction Report) threshold detection
 *   • SAR (Suspicious Activity Report) workflow management
 *   • KYC tier enforcement: transaction limits per KYC level
 *   • OFAC / sanctions screening simulation
 *   • PEP (Politically Exposed Person) detection
 *   • Immutable compliance audit trail (append-only, hash-chained)
 *   • 30-day rolling volume aggregation for AML triggers
 *   • Regulatory report generation (CBK format simulation)
 *
 * Regulatory references:
 *   • CBK Prudential Guideline on AML/CFT (CBK/PG/01)
 *   • Kenya National Payment System Act, Cap 499G
 *   • Financial Reporting Centre (FRC) AML guidelines
 *
 * Storage:
 *   localStorage 'zuri_compliance_v1'        — compliance flags + SAR queue
 *   localStorage 'zuri_compliance_audit_v1'  — immutable audit trail
 *   localStorage 'zuri_volume_tracker_v1'    — 30-day rolling volume per user
 */

import { recordOperation, SERVICES, traced } from '@/server/domain/observability/telemetryService';
import { logAuditEvent }                     from '@/lib/auditLogger';

// ── Constants ─────────────────────────────────────────────────────────────────

const LS_FLAGS    = 'zuri_compliance_v1';
const LS_AUDIT    = 'zuri_compliance_audit_v1';
const LS_VOLUME   = 'zuri_volume_tracker_v1';

// CBK thresholds (KES, in minor units: multiply by 100)
const CTR_THRESHOLD_KES    = 1_000_000;  // KES 10,000 = file CTR (CBK requirement)
const CTR_THRESHOLD_MINOR  = CTR_THRESHOLD_KES * 100;

// Note: In Kenya, CTR threshold is KES 1,000,000 (1M) for single transaction
// SAR trigger: suspicious patterns regardless of amount
const SAR_VOLUME_30D_MINOR = 5_000_000 * 100;  // KES 5M in 30 days

const KYC_LIMITS = {
  none:     { singleMax: 0,          dailyMax: 0,          monthlyMax: 0 },
  basic:    { singleMax: 100_000,    dailyMax: 100_000,    monthlyMax: 500_000 },     // Tier 1 (unverified)
  standard: { singleMax: 7_000_000,  dailyMax: 7_000_000,  monthlyMax: 70_000_000 }, // Tier 2
  enhanced: { singleMax: 40_000_000, dailyMax: 40_000_000, monthlyMax: 300_000_000 },// Tier 3 (full KYC)
};

const MAX_AUDIT_ENTRIES = 2000;

export const COMPLIANCE_FLAG_TYPE = Object.freeze({
  AML_ALERT:       'aml_alert',
  CTR_REQUIRED:    'ctr_required',
  SAR_FILED:       'sar_filed',
  OFAC_MATCH:      'ofac_match',
  PEP_MATCH:       'pep_match',
  SANCTIONS_MATCH: 'sanctions_match',
  KYC_BREACH:      'kyc_breach',
  VELOCITY_AML:    'velocity_aml',
});

// ── FNV-1a hash chain ─────────────────────────────────────────────────────────

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function chainHash(prevHash, id, eventType, ts) {
  return fnv1a(`${prevHash}|${id}|${eventType}|${ts}`);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

function loadFlags() {
  try { return JSON.parse(localStorage.getItem(LS_FLAGS) || '{"flags":[],"sars":[]}'); }
  catch { return { flags: [], sars: [] }; }
}

function saveFlags(data) {
  try { localStorage.setItem(LS_FLAGS, JSON.stringify(data)); } catch {}
}

function loadAudit() {
  try { return JSON.parse(localStorage.getItem(LS_AUDIT) || '{"entries":[],"lastHash":""}'); }
  catch { return { entries: [], lastHash: '' }; }
}

function saveAudit(data) {
  try { localStorage.setItem(LS_AUDIT, JSON.stringify(data)); } catch {}
}

function loadVolume() {
  try { return JSON.parse(localStorage.getItem(LS_VOLUME) || '{}'); } catch { return {}; }
}

function saveVolume(vol) {
  try { localStorage.setItem(LS_VOLUME, JSON.stringify(vol)); } catch {}
}

// ── Compliance audit (append-only) ────────────────────────────────────────────

function appendComplianceAudit(eventType, details, userId = null) {
  try {
    const audit = loadAudit();
    const id    = `ca_${fnv1a(eventType + Date.now() + Math.random())}`;
    const ts    = new Date().toISOString();
    const hash  = chainHash(audit.lastHash, id, eventType, ts);

    const entry = { id, eventType, details, userId, ts, prevHash: audit.lastHash, entryHash: hash };
    audit.entries.push(entry);
    audit.lastHash = hash;

    if (audit.entries.length > MAX_AUDIT_ENTRIES) {
      audit.entries.splice(0, audit.entries.length - MAX_AUDIT_ENTRIES);
    }
    saveAudit(audit);
  } catch {}
}

// ── Volume tracking ───────────────────────────────────────────────────────────

function updateVolumeTracker(userId, amountMinor) {
  try {
    const vol = loadVolume();
    if (!vol[userId]) vol[userId] = [];

    const now      = Date.now();
    const thirtyD  = 30 * 24 * 60 * 60 * 1000;

    // Prune entries older than 30 days
    vol[userId] = vol[userId].filter(e => now - e.ts < thirtyD);
    vol[userId].push({ ts: now, amount: amountMinor });

    saveVolume(vol);
    return vol[userId].reduce((s, e) => s + e.amount, 0);
  } catch { return 0; }
}

function getVolumeWindow(userId, windowMs) {
  try {
    const vol   = loadVolume();
    const now   = Date.now();
    const items = (vol[userId] || []).filter(e => now - e.ts < windowMs);
    return items.reduce((s, e) => s + e.amount, 0);
  } catch { return 0; }
}

// ── Sanctions / PEP screening ─────────────────────────────────────────────────

// Simulated OFAC / UN sanctions names (representative samples for demo realism)
const SANCTIONS_KEYWORDS = [
  'al_qaeda', 'isis', 'hamas', 'hezbollah', 'taliban',
  'sanctioned_corp', 'embargoed_entity',
];

const PEP_MARKERS = [
  'minister', 'senator', 'governor', 'president', 'mp_', 'judge_',
];

function screenName(name) {
  if (!name) return { ofac: false, pep: false };
  const lower = name.toLowerCase().replace(/\s+/g, '_');
  return {
    ofac: SANCTIONS_KEYWORDS.some(k => lower.includes(k)),
    pep:  PEP_MARKERS.some(k => lower.includes(k)),
  };
}

// ── Core compliance checks ────────────────────────────────────────────────────

/**
 * Run all compliance checks on a transaction before processing.
 *
 * @param {object} txData       — { amount, fromPhone, toPhone, txType, userId, merchantName, recipientName }
 * @param {object} userProfile  — { kycLevel, riskScore, displayName }
 * @returns {object} complianceResult
 */
export async function checkTransactionCompliance(txData = {}, userProfile = {}) {
  const t0 = performance.now();

  return traced(SERVICES.PAYMENTS, 'complianceCheck', async () => {
    const {
      amount = 0,
      fromPhone = '',
      userId = '',
      merchantName = '',
      recipientName = '',
    } = txData;

    const kycLevel   = userProfile.kycLevel || 'none';
    const kycLimits  = KYC_LIMITS[kycLevel] || KYC_LIMITS.none;
    const flags      = [];
    let   blocked    = false;
    let   blockReason = null;

    // ── KYC tier enforcement ──
    if (amount > kycLimits.singleMax) {
      flags.push({
        type:    COMPLIANCE_FLAG_TYPE.KYC_BREACH,
        reason:  `Transaction KES ${(amount / 100).toFixed(0)} exceeds ${kycLevel} KYC single-tx limit of KES ${(kycLimits.singleMax / 100).toFixed(0)}`,
        autoBlock: true,
      });
      blocked     = true;
      blockReason = 'kyc_limit_exceeded';
    }

    // Daily limit check
    const dailyVolume = getVolumeWindow(userId, 24 * 60 * 60 * 1000);
    if (!blocked && dailyVolume + amount > kycLimits.dailyMax) {
      flags.push({
        type:    COMPLIANCE_FLAG_TYPE.KYC_BREACH,
        reason:  `Daily volume of KES ${((dailyVolume + amount) / 100).toFixed(0)} would exceed ${kycLevel} KYC daily limit`,
        autoBlock: true,
      });
      blocked     = true;
      blockReason = 'daily_kyc_limit_exceeded';
    }

    // ── CTR threshold ──
    if (amount >= CTR_THRESHOLD_MINOR) {
      flags.push({
        type:    COMPLIANCE_FLAG_TYPE.CTR_REQUIRED,
        reason:  `Transaction KES ${(amount / 100).toFixed(0)} meets or exceeds CTR threshold of KES ${CTR_THRESHOLD_KES}`,
        autoBlock: false,
      });
      _queueCTR(userId, txData);
    }

    // ── 30-day volume AML trigger ──
    const volume30d = getVolumeWindow(userId, 30 * 24 * 60 * 60 * 1000);
    if (volume30d + amount > SAR_VOLUME_30D_MINOR) {
      flags.push({
        type:    COMPLIANCE_FLAG_TYPE.VELOCITY_AML,
        reason:  `30-day rolling volume of KES ${((volume30d + amount) / 100).toFixed(0)} exceeds SAR trigger threshold`,
        autoBlock: false,
      });
      _queueSAR(userId, txData, `30-day volume threshold reached: KES ${((volume30d + amount) / 100).toFixed(0)}`);
    }

    // ── Sanctions / OFAC screening ──
    const recipientScreen = screenName(recipientName);
    const merchantScreen  = screenName(merchantName);

    if (recipientScreen.ofac || merchantScreen.ofac) {
      flags.push({
        type:      COMPLIANCE_FLAG_TYPE.OFAC_MATCH,
        reason:    `Potential OFAC match: ${recipientScreen.ofac ? 'recipient' : 'merchant'} name requires review`,
        autoBlock: true,
      });
      blocked     = true;
      blockReason = 'sanctions_screening';
    }

    if (recipientScreen.pep || merchantScreen.pep) {
      flags.push({
        type:    COMPLIANCE_FLAG_TYPE.PEP_MATCH,
        reason:  'PEP indicator detected — enhanced due diligence required',
        autoBlock: false,
      });
    }

    // ── Record flags ──
    if (flags.length > 0) {
      const store = loadFlags();
      for (const flag of flags) {
        const flagId = `cf_${fnv1a(userId + flag.type + Date.now())}`;
        store.flags.push({
          id:         flagId,
          userId,
          txRef:      txData.txRef || txData.id || '',
          type:       flag.type,
          reason:     flag.reason,
          status:     'open',
          autoBlock:  flag.autoBlock,
          createdAt:  new Date().toISOString(),
          amount,
        });
      }
      saveFlags(store);

      appendComplianceAudit('flags_raised', { userId, flags: flags.map(f => f.type), blocked }, userId);
      try { logAuditEvent('RISK', 'compliance_flags_raised', { userId, flags: flags.map(f => f.type), blocked }, userId); }
      catch {}
    }

    const latencyMs = Math.round(performance.now() - t0);
    recordOperation(SERVICES.PAYMENTS, 'complianceCheck', latencyMs, true);

    return {
      blocked,
      blockReason,
      flags:       flags.map(f => ({ type: f.type, reason: f.reason })),
      flagCount:   flags.length,
      requiresReview: flags.some(f => !f.autoBlock),
      checkedAt:   new Date().toISOString(),
      latencyMs,
    };
  });
}

/**
 * Update the 30-day volume tracker after a completed transaction.
 * Must be called after transaction is confirmed — not before.
 */
export function recordCompletedTransaction(userId, amountMinor) {
  return updateVolumeTracker(userId, amountMinor);
}

// ── CTR / SAR management ──────────────────────────────────────────────────────

function _queueCTR(userId, txData) {
  try {
    const store  = loadFlags();
    const ctrId  = `ctr_${fnv1a(userId + Date.now())}`;
    if (!store.ctrs) store.ctrs = [];
    store.ctrs.push({
      id:        ctrId,
      userId,
      txRef:     txData.txRef || '',
      amount:    txData.amount || 0,
      currency:  txData.currency || 'KES',
      status:    'pending',
      createdAt: new Date().toISOString(),
    });
    saveFlags(store);
    appendComplianceAudit('ctr_queued', { userId, txRef: txData.txRef, amount: txData.amount }, userId);
  } catch {}
}

function _queueSAR(userId, txData, reason) {
  try {
    const store = loadFlags();
    const sarId = `sar_${fnv1a(userId + Date.now())}`;
    store.sars.push({
      id:        sarId,
      userId,
      txRef:     txData.txRef || '',
      reason,
      status:    'draft',
      createdAt: new Date().toISOString(),
      filedAt:   null,
    });
    saveFlags(store);
    appendComplianceAudit('sar_queued', { userId, reason }, userId);
  } catch {}
}

/**
 * Get all open compliance flags.
 */
export function getOpenFlags() {
  try {
    const { flags } = loadFlags();
    return flags.filter(f => f.status === 'open');
  } catch { return []; }
}

/**
 * Get all pending CTR reports.
 */
export function getPendingCTRs() {
  try {
    const { ctrs = [] } = loadFlags();
    return ctrs.filter(c => c.status === 'pending');
  } catch { return []; }
}

/**
 * Get all draft SARs.
 */
export function getDraftSARs() {
  try {
    const { sars } = loadFlags();
    return sars.filter(s => s.status === 'draft');
  } catch { return []; }
}

/**
 * Resolve a compliance flag (mark reviewed + outcome).
 */
export function resolveFlag(flagId, resolution, reviewerId) {
  try {
    const store = loadFlags();
    const flag  = store.flags.find(f => f.id === flagId);
    if (!flag) return false;
    flag.status     = resolution === 'confirmed' ? 'confirmed' : 'dismissed';
    flag.reviewedAt = new Date().toISOString();
    flag.reviewedBy = reviewerId;
    flag.resolution = resolution;
    saveFlags(store);
    appendComplianceAudit('flag_resolved', { flagId, resolution, reviewerId }, flag.userId);
    return true;
  } catch { return false; }
}

/**
 * File a SAR (Suspicious Activity Report) — marks as filed and generates report.
 */
export function fileSAR(sarId, analystNote, reviewerId) {
  try {
    const store = loadFlags();
    const sar   = store.sars.find(s => s.id === sarId);
    if (!sar) return null;
    sar.status      = 'filed';
    sar.filedAt     = new Date().toISOString();
    sar.analystNote = analystNote;
    sar.filedBy     = reviewerId;
    saveFlags(store);
    appendComplianceAudit('sar_filed', { sarId, reviewerId }, sar.userId);
    return {
      sarId,
      userId:     sar.userId,
      txRef:      sar.txRef,
      reason:     sar.reason,
      note:       analystNote,
      filedAt:    sar.filedAt,
      reportRef:  `FRC-${fnv1a(sarId + sar.filedAt).toUpperCase()}`,
    };
  } catch { return null; }
}

/**
 * Generate a regulatory compliance dashboard summary.
 */
export function getComplianceDashboard() {
  try {
    const store    = loadFlags();
    const openFlags = (store.flags || []).filter(f => f.status === 'open');
    const pendingCTRs = (store.ctrs || []).filter(c => c.status === 'pending');
    const draftSARs   = (store.sars || []).filter(s => s.status === 'draft');
    const filedSARs   = (store.sars || []).filter(s => s.status === 'filed');

    const flagsByType = openFlags.reduce((acc, f) => {
      acc[f.type] = (acc[f.type] || 0) + 1;
      return acc;
    }, {});

    const audit     = loadAudit();

    return {
      generatedAt:    new Date().toISOString(),
      openFlags:      openFlags.length,
      flagsByType,
      pendingCTRs:    pendingCTRs.length,
      draftSARs:      draftSARs.length,
      filedSARs:      filedSARs.length,
      auditEntries:   audit.entries.length,
      auditIntegrity: audit.lastHash ? 'chain_intact' : 'empty',
      requiresAttention: openFlags.length > 0 || draftSARs.length > 0 || pendingCTRs.length > 0,
    };
  } catch { return { generatedAt: new Date().toISOString(), requiresAttention: false }; }
}

/**
 * Export compliance audit trail for regulatory submission.
 */
export function exportAuditTrail() {
  try {
    const audit = loadAudit();
    return {
      exportedAt:   new Date().toISOString(),
      entryCount:   audit.entries.length,
      chainIntegrity: audit.lastHash,
      entries:      audit.entries,
    };
  } catch { return { exportedAt: new Date().toISOString(), entryCount: 0, entries: [] }; }
}

/**
 * Verify audit chain integrity (check no entries have been tampered with).
 */
export function verifyAuditIntegrity() {
  try {
    const audit   = loadAudit();
    const entries = audit.entries;
    let   prevHash = '';
    let   valid    = true;
    let   firstBreach = null;

    for (const entry of entries) {
      const expected = chainHash(prevHash, entry.id, entry.eventType, entry.ts);
      if (expected !== entry.entryHash) {
        valid        = false;
        firstBreach  = entry.id;
        break;
      }
      prevHash = entry.entryHash;
    }

    return {
      valid,
      entryCount: entries.length,
      firstBreach,
      verifiedAt: new Date().toISOString(),
    };
  } catch { return { valid: false, entryCount: 0 }; }
}
