import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { formatDate } from '@/lib/mpesa.js';
import {
  ELEVATED_ADMIN_ROLES,
  getRouteProtection,
} from '@/lib/routeGuard.js';

const ROOT = process.cwd();

function source(file) {
  return readFileSync(resolve(ROOT, file), 'utf8');
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function visibleStringCandidates(text) {
  const out = [];
  const re = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = re.exec(stripComments(text)))) {
    const value = match[2].replace(/\\n/g, ' ');
    if (!value.trim()) continue;
    if (/^[@./\w-]+(?:\.\w+)?$/.test(value)) continue;
    out.push(value);
  }
  return out.join('\n');
}

function walkFiles(dir) {
  const result = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) result.push(...walkFiles(full));
    else result.push(full);
  }
  return result;
}

describe('pre-pitch visible copy guardrails', () => {
  const keyUiFiles = [
    'src/pages/Home.jsx',
    'src/pages/AI.jsx',
    'src/pages/Budget.jsx',
    'src/pages/Profile.jsx',
    'src/pages/History.jsx',
    'src/pages/Send.jsx',
    'src/pages/Paybill.jsx',
    'src/pages/Airtime.jsx',
    'src/pages/Bundles.jsx',
    'src/pages/SecurityCentre.jsx',
    'src/pages/admin/ReconciliationCommandCenter.jsx',
    'src/components/home/BalanceCard.jsx',
    'src/components/auth/FaceID.jsx',
    'src/components/auth/VoiceBiometric.jsx',
    'src/components/budget/AIInsightsPanel.jsx',
  ];

  it('keeps forbidden legacy/demo/error strings out of key user-facing copy', () => {
    const visibleText = keyUiFiles.map((file) => `${file}\n${visibleStringCandidates(source(file))}`).join('\n');
    expect(visibleText).not.toMatch(/Safi AI|Zuri AI advisor|Financial Advisor/i);
    expect(visibleText).not.toMatch(/AI service (?:temporarily )?unavailable/i);
    expect(visibleText).not.toMatch(/Invalid Date|254712345678/i);
    expect(visibleText).not.toMatch(/\b(?:demo|mock|fake|test)\b/i);
    expect(visibleText).not.toMatch(/raw provider|stack trace/i);
  });
});

describe('pre-pitch console and health checks', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offline health quality check does not probe Supabase /health', async () => {
    const { detectConnectionQualityAsync } = await import('@/lib/offlineQueue.js');
    await detectConnectionQualityAsync();
    expect(fetch).not.toHaveBeenCalled();

    const offlineQueueSource = stripComments(source('src/lib/offlineQueue.js'));
    expect(offlineQueueSource).not.toMatch(/fetch\([^)]*\/health/i);
    expect(offlineQueueSource).not.toMatch(/supabase\.co\/health/i);
  });

  it('manual offline sync does not process financial-priority drafts', () => {
    const hookSource = stripComments(source('src/lib/network/connectivityHook.js')).replace(/\s+/g, ' ');
    expect(hookSource).toMatch(/syncPendingActions\(\{\s*maxPriority:\s*ACTION_PRIORITY\.ACCOUNT\s*\}\)/);
    expect(hookSource).not.toMatch(/await\s+syncPendingActions\(\s*\)/);
  });

  it('wallet preview link never asks for the real M-Pesa PIN', () => {
    const modalSource = stripComments(source('src/components/wallet/LinkWalletModal.jsx'));
    expect(modalSource).not.toMatch(/M-Pesa PIN must/i);
    expect(modalSource).not.toMatch(/^M-Pesa PIN$/m);
    expect(modalSource).not.toMatch(/Link M-Pesa Account/i);
    expect(modalSource).toMatch(/Do not enter your M-Pesa PIN/i);
    expect(modalSource).toMatch(/Preview confirmation PIN/i);
  });

  it('production boot logs are gated behind the debug logger', () => {
    const bootFiles = [
      'src/main.jsx',
      'src/App.jsx',
      'src/lib/AuthContext.jsx',
      'src/components/layout/AppShell.jsx',
      'src/components/security/RouteGuard.jsx',
    ];
    for (const file of bootFiles) {
      const text = source(file);
      expect(text).not.toMatch(/console\.(?:info|warn|debug)\([^)]*\[Zuri:Boot]/);
      expect(text).toMatch(/bootInfo|bootWarn|console\.error/);
    }
    expect(source('src/lib/devLog.js')).toMatch(/VITE_DEBUG_BOOT/);
  });
});

describe('pre-pitch route and admin safety', () => {
  it('normal users cannot access admin reconciliation while elevated roles can', () => {
    const config = getRouteProtection('/admin/reconciliation');
    expect(config.level).toBe('admin');
    expect(config.allowedRoles).toEqual(ELEVATED_ADMIN_ROLES);
    expect(config.allowedRoles).not.toContain('customer');
    expect(config.allowedRoles).toEqual(expect.arrayContaining(['admin', 'auditor', 'fraud_analyst']));
  });

  it('admin reconciliation frontend never exposes raw provider payload fields', () => {
    const page = stripComments(source('src/pages/admin/ReconciliationCommandCenter.jsx'));
    const api = stripComments(source('src/lib/admin/reconciliationApi.js'));
    expect(page + api).not.toMatch(/raw_callback|raw_provider_payload|webhook_events/);
  });
});

describe('pre-pitch formatting and Edge safety', () => {
  it('date formatting never surfaces Invalid Date', () => {
    expect(formatDate('not-a-date')).toBe('Unknown date');
    expect(formatDate(null)).toBe('Unknown date');
  });

  it('sensitive Edge Functions do not return raw provider errors to browsers', () => {
    const edgeSource = [
      'supabase/functions/initiate-payment/index.ts',
      'supabase/functions/complete-step-up/index.ts',
      'supabase/functions/webhook-handler/index.ts',
      'supabase/functions/ai-router/index.ts',
    ].map((file) => stripComments(source(file))).join('\n');

    expect(edgeSource).not.toMatch(/return\s+json\([^)]*message:\s*(?:pendingErr|error|stk)\.(?:message|responseDescription)/);
    expect(edgeSource).not.toMatch(/return\s+json\([^)]*error:\s*error\s+instanceof\s+Error\s*\?\s*error\.message/);
    expect(edgeSource).not.toMatch(/return\s+Response\.json\([^)]*error:\s*error\s+instanceof\s+Error\s*\?\s*error\.message/);
    expect(edgeSource).not.toMatch(/return\s+json\([^)]*error:\s*e\s+instanceof\s+Error\s*\?\s*e\.message/);
  });

  it('frontend webhook verification never reads VITE_* webhook secrets', () => {
    const webhookVerifier = source('src/backend/webhooks/verifyWebhook.js');
    expect(webhookVerifier).not.toMatch(/VITE_.*WEBHOOK_SECRET/i);
  });

  it('sensitive Edge Functions do not use wildcard CORS', () => {
    const functionFiles = walkFiles(resolve(ROOT, 'supabase/functions'))
      .filter((file) => /\.(ts|js)$/.test(file))
      .map((file) => stripComments(readFileSync(file, 'utf8')).replace(/\s+/g, ' '));
    const combined = functionFiles.join('\n');
    expect(combined).not.toMatch(/Access-Control-Allow-Origin['"]?\s*:\s*['"]\*/i);
    expect(combined).not.toMatch(/allowedOrigin\s*=\s*['"]\*/i);
  });
});
