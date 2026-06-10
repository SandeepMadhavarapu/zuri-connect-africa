/**
 * Zuri Connect Africa - AI Actions Engine
 * AI may prepare and explain actions, but financial and security actions are
 * only proposals. Execution remains in the normal authenticated app flows.
 */

import { audit } from '../auditLogger';
import { emit } from '../eventBus';

export const ACTION_TYPES = {
  RETRY_TRANSACTION: 'retry_transaction',
  FREEZE_WALLET: 'freeze_wallet',
  REPORT_SCAM: 'report_scam',
  SCHEDULE_PAYMENT: 'schedule_payment',
  REVERSE_TRANSFER: 'reverse_transfer',
  ENABLE_PROTECTION: 'enable_protection',
  SECURITY_REVIEW: 'security_review',
};

const ACTION_CATALOG = {
  retry_transaction: {
    label: 'Retry Failed Payment',
    description: 'Open the transaction history so you can review and retry a failed payment through the secure payment flow.',
    icon: 'RefreshCw',
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    requiresConfirmation: true,
    proposalOnly: true,
    path: '/history',
  },
  freeze_wallet: {
    label: 'Review Wallet Freeze',
    description: 'Open Security Centre so you can review protection options. Security changes require confirmation there.',
    icon: 'ShieldAlert',
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    requiresConfirmation: true,
    requiresStepUp: true,
    proposalOnly: true,
    path: '/security',
  },
  report_scam: {
    label: 'Report Suspicious Activity',
    description: 'Prepare a fraud report for your review.',
    icon: 'AlertTriangle',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    requiresConfirmation: true,
    proposalOnly: true,
    path: '/security',
  },
  schedule_payment: {
    label: 'Schedule a Payment',
    description: 'Prepare a recurring payment setup for your review.',
    icon: 'Calendar',
    color: 'text-primary',
    bg: 'bg-primary/10',
    requiresConfirmation: true,
    proposalOnly: true,
    path: '/schedules',
  },
  reverse_transfer: {
    label: 'Request Transfer Reversal',
    description: 'Open transaction history so you can review the transfer and request support.',
    icon: 'Undo2',
    color: 'text-orange-400',
    bg: 'bg-orange-400/10',
    requiresConfirmation: true,
    proposalOnly: true,
    path: '/history',
  },
  enable_protection: {
    label: 'Review Protection Mode',
    description: 'Open Security Centre so you can review protection settings.',
    icon: 'ShieldCheck',
    color: 'text-primary',
    bg: 'bg-primary/10',
    requiresConfirmation: false,
    proposalOnly: true,
    path: '/security',
  },
  security_review: {
    label: 'Review Security Request',
    description: 'Open Security Centre so you can review and confirm any security-sensitive change.',
    icon: 'ShieldCheck',
    color: 'text-primary',
    bg: 'bg-primary/10',
    requiresConfirmation: true,
    requiresStepUp: true,
    proposalOnly: true,
    path: '/security',
  },
  support_draft: {
    label: 'Review Support Draft',
    description: 'Prepare support details for your review.',
    icon: 'AlertTriangle',
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    requiresConfirmation: true,
    proposalOnly: true,
    path: '/ai',
  },
  draft_action: {
    label: 'Review Draft',
    description: 'Review the prepared draft before taking any action.',
    icon: 'ShieldCheck',
    color: 'text-primary',
    bg: 'bg-primary/10',
    requiresConfirmation: true,
    proposalOnly: true,
    path: '/ai',
  },
};

const ACTION_LOG_KEY = 'zuri_ai_actions_log';

function appendActionLog(entry) {
  try {
    const log = JSON.parse(sessionStorage.getItem(ACTION_LOG_KEY) || '[]');
    log.unshift(entry);
    sessionStorage.setItem(ACTION_LOG_KEY, JSON.stringify(log.slice(0, 30)));
  } catch {}
}

export function getActionCatalog(types) {
  if (types) return types.map((t) => ({ id: t, ...ACTION_CATALOG[t] })).filter(Boolean);
  return Object.entries(ACTION_CATALOG).map(([id, cfg]) => ({ id, ...cfg }));
}

export function getActionConfig(type) {
  return ACTION_CATALOG[type] ? { id: type, ...ACTION_CATALOG[type] } : null;
}

export async function executeAction(type, params = {}, userId) {
  const config = ACTION_CATALOG[type];
  if (!config) throw new Error(`Unknown action: ${type}`);

  const rollbackToken = `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const status = config.proposalOnly ? 'proposal_confirmed' : 'executed';

  appendActionLog({
    rollbackToken,
    type,
    params,
    userId: userId || 'anonymous',
    status,
    ts: Date.now(),
  });

  try {
    audit.atoSignal(
      config.proposalOnly ? `ai_action_proposal_confirmed_${type}` : `ai_action_${type}`,
      `params=${JSON.stringify(params)}`,
      userId
    );
    emit(config.proposalOnly ? 'AI_ACTION_PROPOSAL_CONFIRMED' : 'AI_ACTION_EXECUTED', {
      type,
      params,
      rollbackToken,
      userId,
    });
  } catch {}

  return {
    success: true,
    message: config.proposalOnly
      ? `${config.label} is ready. Review and confirm in the secure flow.`
      : `${config.label} - action confirmed and logged.`,
    rollbackToken,
    path: config.path,
  };
}

export function getActionLog() {
  try { return JSON.parse(sessionStorage.getItem(ACTION_LOG_KEY) || '[]'); } catch { return []; }
}

export function suggestActionsFromResponse(responseText) {
  const lower = String(responseText || '').toLowerCase();
  const suggestions = [];
  if (/failed|retry|unsuccessful/.test(lower)) suggestions.push('retry_transaction');
  if (/freeze|block|suspicious|fraud/.test(lower)) suggestions.push('freeze_wallet');
  if (/scam|report|suspicious/.test(lower)) suggestions.push('report_scam');
  if (/schedul|recurring|automat/.test(lower)) suggestions.push('schedule_payment');
  if (/protect|secure|safety|pin/.test(lower)) suggestions.push('enable_protection');
  return [...new Set(suggestions)].slice(0, 3);
}
