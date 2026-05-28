// Demo Mode Controller — Zuri Connect Africa
// Executive-style toggles and client-side biometric theatre are gated by
// `src/config/clientSecurityPolicy.js` (staging/production/strict → off).

import { getClientDemoPolicy } from '@/config/clientSecurityPolicy.js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

const DEMO_KEY = 'zuri_demo_config';
const DEMO_TXNS_STORAGE_KEY = 'zuri_demo_transactions_v1';
const DEMO_SEEDED_FLAG = 'zuri_demo_seeded';

const DEFAULT_CONFIG = {
  enabled: false,
  forcedRiskLevel: null,
  biometricSuccess: false,
  biometricDelay: 3000,
  fraudAlertEnabled: false,
  fraudAlertType: 'unusual_location',
  confidenceScore: 94,
};

function readStoredDemoTransactionsRaw() {
  try {
    const raw = localStorage.getItem(DEMO_TXNS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function hasRealNonDemoActivity() {
  try {
    const ledgerRaw = localStorage.getItem('zuri_local_ledger_v1');
    if (ledgerRaw) {
      const arr = JSON.parse(ledgerRaw);
      if (
        Array.isArray(arr) &&
        arr.some((e) => {
          const r = String(e.transactionRef ?? e.transaction_ref ?? '');
          return r && !r.startsWith('TXN-DEMO-');
        })
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const w = sessionStorage.getItem('mpesa_wallet');
    if (w) {
      const o = JSON.parse(w);
      if (o?.linked && String(o.phone || '').trim().length > 0) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function buildCanonicalDemoTransactions() {
  const rows = [
    {
      ref: 'TXN-DEMO-001',
      occurredAt: '2026-04-10T08:15:00.000Z',
      direction: 'credit',
      amount: 52000,
      balance_before: 0,
      balance_after: 52000,
      displayName: 'Salary — Andela Kenya Ltd',
      category: 'receive',
    },
    {
      ref: 'TXN-DEMO-002',
      occurredAt: '2026-04-11T09:30:00.000Z',
      direction: 'debit',
      amount: 18500,
      balance_before: 52000,
      balance_after: 33500,
      displayName: 'Rent — Westlands apartment',
      category: 'send',
    },
    {
      ref: 'TXN-DEMO-003',
      occurredAt: '2026-04-12T12:45:00.000Z',
      direction: 'debit',
      amount: 3200,
      balance_before: 33500,
      balance_after: 30300,
      displayName: 'Naivas Supermarket — Westlands',
      category: 'send',
    },
    {
      ref: 'TXN-DEMO-004',
      occurredAt: '2026-04-13T07:20:00.000Z',
      direction: 'debit',
      amount: 1500,
      balance_before: 30300,
      balance_after: 28800,
      displayName: 'Safaricom airtime top-up',
      category: 'airtime',
    },
    {
      ref: 'TXN-DEMO-005',
      occurredAt: '2026-04-14T10:00:00.000Z',
      direction: 'debit',
      amount: 800,
      balance_before: 28800,
      balance_after: 28000,
      displayName: '3GB data bundle — Safaricom',
      category: 'bundle',
    },
    {
      ref: 'TXN-DEMO-006',
      occurredAt: '2026-04-15T18:30:00.000Z',
      direction: 'debit',
      amount: 2500,
      balance_before: 28000,
      balance_after: 25500,
      displayName: 'KPLC electricity token 0100298771',
      category: 'paybill',
    },
    {
      ref: 'TXN-DEMO-007',
      occurredAt: '2026-04-16T07:55:00.000Z',
      direction: 'debit',
      amount: 650,
      balance_before: 25500,
      balance_after: 24850,
      displayName: 'Bolt — Westlands to CBD',
      category: 'send',
    },
    {
      ref: 'TXN-DEMO-008',
      occurredAt: '2026-04-18T16:10:00.000Z',
      direction: 'debit',
      amount: 5000,
      balance_before: 24850,
      balance_after: 19850,
      displayName: 'Family transfer — Kisumu',
      category: 'send',
    },
    {
      ref: 'TXN-DEMO-009',
      occurredAt: '2026-04-19T11:40:00.000Z',
      direction: 'debit',
      amount: 2000,
      balance_before: 19850,
      balance_after: 17850,
      displayName: 'Harambee contribution',
      category: 'send',
    },
    {
      ref: 'TXN-DEMO-010',
      occurredAt: '2026-04-21T08:05:00.000Z',
      direction: 'debit',
      amount: 3000,
      balance_before: 17850,
      balance_after: 14850,
      displayName: 'Fuliza overdraft repayment',
      category: 'fuliza',
    },
    {
      ref: 'TXN-DEMO-011',
      occurredAt: '2026-04-22T19:25:00.000Z',
      direction: 'debit',
      amount: 1850,
      balance_before: 14850,
      balance_after: 13000,
      displayName: 'DStv Paybill payment',
      category: 'paybill',
    },
    {
      ref: 'TXN-DEMO-012',
      occurredAt: '2026-04-25T14:00:00.000Z',
      direction: 'credit',
      amount: 8000,
      balance_before: 13000,
      balance_after: 21000,
      displayName: 'M-PESA reversal received',
      category: 'receive',
    },
    {
      ref: 'TXN-DEMO-013',
      occurredAt: '2026-04-28T09:50:00.000Z',
      direction: 'credit',
      amount: 15000,
      balance_before: 21000,
      balance_after: 36000,
      displayName: 'Freelance payment — Safaricom Digital',
      category: 'receive',
    },
    {
      ref: 'TXN-DEMO-014',
      occurredAt: '2026-05-02T13:15:00.000Z',
      direction: 'debit',
      amount: 1200,
      balance_before: 36000,
      balance_after: 34800,
      displayName: 'Java House — Westlands',
      category: 'send',
    },
    {
      ref: 'TXN-DEMO-015',
      occurredAt: '2026-05-09T17:00:00.000Z',
      direction: 'debit',
      amount: 4500,
      balance_before: 34800,
      balance_after: 30300,
      displayName: 'Equity Bank Paybill',
      category: 'paybill',
    },
  ];
  return rows;
}

function readDemoConfigFromStorage() {
  try {
    const stored = JSON.parse(localStorage.getItem(DEMO_KEY) || 'null');
    return { ...DEFAULT_CONFIG, ...stored };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Merged demo config; staging/production/strict ignore persisted executive overrides. */
export function getDemoConfig() {
  const policy = getClientDemoPolicy();
  if (!policy.allowBrowserDemoControls) {
    return {
      ...DEFAULT_CONFIG,
      enabled: false,
      forcedRiskLevel: null,
      biometricSuccess: false,
      fraudAlertEnabled: false,
      pinBypass: false,
    };
  }
  return readDemoConfigFromStorage();
}

export function setDemoConfig(patch) {
  if (!getClientDemoPolicy().allowBrowserDemoControls) {
    return getDemoConfig();
  }
  const current = readDemoConfigFromStorage();
  const updated = { ...current, ...patch };
  localStorage.setItem(DEMO_KEY, JSON.stringify(updated));
  return updated;
}

export function resetDemoConfig() {
  localStorage.removeItem(DEMO_KEY);
  return { ...DEFAULT_CONFIG };
}

export function isDemoMode() {
  return getDemoConfig().enabled;
}

export function getEffectiveRiskLevel(calculated) {
  const config = getDemoConfig();
  if (config.enabled && config.forcedRiskLevel) {
    return config.forcedRiskLevel;
  }
  return calculated;
}

export async function simulateBiometricResult(type) {
  const policy = getClientDemoPolicy();
  if (!policy.allowBiometricClientSimulation) {
    const blockedStages = {
      voice: [{ label: 'Client simulation disabled in this environment', ms: 200 }],
      face: [{ label: 'Client simulation disabled in this environment', ms: 200 }],
    };
    return {
      success: false,
      policyDenied: true,
      confidence: 0,
      stages: blockedStages[type] || blockedStages.face,
      totalMs: 200,
    };
  }

  const config = getDemoConfig();
  const delay = config.enabled ? config.biometricDelay : 2000 + Math.random() * 2000;

  const stages = {
    voice: [
      { label: 'Capturing audio sample…', ms: 600 },
      { label: 'Analyzing waveform pattern…', ms: 700 },
      { label: 'Extracting voiceprint features…', ms: 800 },
      { label: 'Running anti-spoof detection…', ms: 600 },
      { label: 'Matching voiceprint profile…', ms: 700 },
      { label: 'Finalizing verification…', ms: 400 },
    ],
    face: [
      { label: 'Detecting face landmarks…', ms: 500 },
      { label: 'Checking liveness…', ms: 700 },
      { label: 'Extracting facial geometry…', ms: 800 },
      { label: 'Running anti-spoofing…', ms: 600 },
      { label: 'Matching facial profile…', ms: 700 },
      { label: 'Finalizing verification…', ms: 400 },
    ],
  };

  const success = config.enabled ? config.biometricSuccess : Math.random() > 0.15;
  const confidence = config.enabled
    ? config.confidenceScore
    : Math.floor(85 + Math.random() * 12);

  return {
    success,
    confidence,
    stages: stages[type] || stages.voice,
    totalMs: delay,
  };
}

export function getFraudAlertScenario() {
  const config = getDemoConfig();
  if (!config.enabled || !config.fraudAlertEnabled) return null;

  const scenarios = {
    unusual_location: {
      title: 'Unusual Location Detected',
      detail: 'Transaction initiated from Mombasa — your account is registered in Nairobi.',
      severity: 'HIGH',
      action: 'step_up_auth',
    },
    velocity: {
      title: 'Transaction Velocity Alert',
      detail: '3 transfers in the last 10 minutes — velocity limit approaching.',
      severity: 'MEDIUM',
      action: 'confirm',
    },
    device_change: {
      title: 'New Device Detected',
      detail: 'This transaction is from a device not previously associated with your account.',
      severity: 'HIGH',
      action: 'step_up_auth',
    },
  };

  return scenarios[config.fraudAlertType] || null;
}

export function isDemoSeeded() {
  try {
    return localStorage.getItem(DEMO_SEEDED_FLAG) === '1';
  } catch {
    return false;
  }
}

export function deriveDemoBalance(transactions) {
  const list = Array.isArray(transactions) ? [...transactions] : [];
  if (list.length === 0) return 0;
  list.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());
  let running = 0;
  for (const t of list) {
    const amt = Number(t.amount) || 0;
    if (t.direction === 'credit') running += amt;
    else running -= amt;
  }
  const last = list[list.length - 1];
  const chain = Number(last.balance_after);
  if (Number.isFinite(chain)) return chain;
  return Math.round((running + Number.EPSILON) * 100) / 100;
}

export function getDemoTransactions() {
  if (!getClientDemoPolicy().allowAnonymousDemoFinancials) return [];
  const rows = readStoredDemoTransactionsRaw();
  return [...rows].sort(
    (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()
  );
}

export function getDemoTransactionsForUi() {
  return getDemoTransactions().map((t) => ({
    id: t.ref,
    type: t.category,
    name: t.displayName,
    amount: t.direction === 'credit' ? Number(t.amount) : -Number(t.amount),
    date: t.occurredAt,
    ref: t.ref,
    status: 'completed',
  }));
}

export async function shouldShowDemoFinancials(isAuthenticatedFlag) {
  if (!getClientDemoPolicy().allowAnonymousDemoFinancials) return false;
  if (isAuthenticatedFlag) return false;
  try {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    if (data?.session?.user) return false;
  } catch {
    /* no session treat as anonymous */
  }
  if (hasRealNonDemoActivity()) return false;
  return true;
}

export async function seedDemoData() {
  if (!getClientDemoPolicy().allowAnonymousDemoFinancials) return;
  if (isDemoSeeded()) return;

  try {
    const { data } = await getSupabaseBrowserClient().auth.getSession();
    if (data?.session?.user) return;
  } catch {
    /* proceed when auth client unavailable */
  }

  if (hasRealNonDemoActivity()) return;

  const canonical = buildCanonicalDemoTransactions();
  const existing = readStoredDemoTransactionsRaw();
  const byRef = new Map(existing.map((t) => [t.ref, t]));
  for (const row of canonical) {
    if (!byRef.has(row.ref)) byRef.set(row.ref, { ...row });
  }
  const merged = Array.from(byRef.values()).sort(
    (a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()
  );

  try {
    localStorage.setItem(DEMO_TXNS_STORAGE_KEY, JSON.stringify(merged));
    localStorage.setItem(DEMO_SEEDED_FLAG, '1');
    window.dispatchEvent(new Event('zuri_demo_updated'));
  } catch {
    /* quota / private mode */
  }
}

export function resetDemoData() {
  try {
    localStorage.removeItem(DEMO_TXNS_STORAGE_KEY);
    localStorage.removeItem(DEMO_SEEDED_FLAG);
    window.dispatchEvent(new Event('zuri_demo_updated'));
  } catch {
    /* ignore */
  }
}

export function getDemoFraudAlerts() {
  return [
    {
      id: 'demo-fr-1',
      title: 'SIM swap warning detected on account',
      severity: 'critical',
      detail: 'Safaricom SIM change correlated with new device in last 24 hours.',
    },
    {
      id: 'demo-fr-2',
      title: 'Unusual login location — London UK',
      severity: 'high',
      detail: 'Session attempted from IP geolocated outside Kenya while account is Nairobi-registered.',
    },
    {
      id: 'demo-fr-3',
      title: 'Transaction velocity spike — 4 transactions in 10 minutes',
      severity: 'medium',
      detail: 'Velocity exceeds typical pattern for this MSISDN; step-up verification recommended.',
    },
  ];
}

export function getDemoAIRecommendations() {
  return [
    {
      id: 'demo-ai-1',
      body: 'You spend 35% of income on rent — Nairobi average is 28%.',
    },
    {
      id: 'demo-ai-2',
      body: 'Your Safaricom bundle expires in 2 days — top up now.',
    },
    {
      id: 'demo-ai-3',
      body: 'You have KSh 8,400 more than last month — great progress.',
    },
  ];
}

export function getDemoNotifications() {
  return [
    {
      id: 'demo-nt-1',
      title: 'M-PESA received',
      body: 'KSh 15,000 from Safaricom Digital.',
    },
    {
      id: 'demo-nt-2',
      title: 'Fraud alert',
      body: 'Unusual login blocked — review Security Centre.',
    },
    {
      id: 'demo-nt-3',
      title: 'Bundle expiry',
      body: 'Bundle expiry reminder — 2 days remaining.',
    },
  ];
}
