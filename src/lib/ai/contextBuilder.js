import { getFirstNameForGreeting } from '@/lib/formatters/userDisplay';
import { CATEGORIES, DEFAULT_LIMITS, MONTHLY_TREND, TRANSACTIONS, getCategorySpend } from '@/components/budget/budgetData';

const SENSITIVE_PATTERN = /\b(otp|one.?time.?password|verification code|pin|password|secret|token|jwt|authorization|service[_ -]?role|api key)\b/i;
const PHONE_PATTERN = /(\+?254|0)?7\d{8}\b/g;
const SIX_DIGIT_CODE_PATTERN = /\b\d{6}\b/g;
const MEMORY_LIMIT = 6;

const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((cat) => [cat.key, cat.label]));

function readJson(storage, key, fallback) {
  try {
    const raw = storage?.getItem?.(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function readString(storage, key, fallback = '') {
  try {
    return storage?.getItem?.(key) || fallback;
  } catch {
    return fallback;
  }
}

export function maskPhone(value) {
  return String(value || '').replace(PHONE_PATTERN, (match) => {
    const digits = match.replace(/\D/g, '');
    return digits ? `***${digits.slice(-4)}` : '[masked phone]';
  });
}

export function sanitizeAIText(value) {
  return maskPhone(String(value || ''))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:sk|pk|rk|srv|service_role)[_-][A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_KEY]')
    .replace(/\b(otp|one.?time.?password|verification code|pin|password|secret|token)\s*[:=]?\s*[A-Za-z0-9-]{3,}\b/gi, '$1 [REDACTED]')
    .replace(SIX_DIGIT_CODE_PATTERN, '[REDACTED_CODE]')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeConversationMessages(messages = [], limit = MEMORY_LIMIT) {
  return (Array.isArray(messages) ? messages : [])
    .filter((msg) => msg && ['user', 'assistant'].includes(msg.role))
    .slice(-limit)
    .map((msg) => ({
      role: msg.role,
      content: sanitizeAIText(msg.content || '').slice(0, 280),
    }))
    .filter((msg) => msg.content && !SENSITIVE_PATTERN.test(msg.content));
}

function maskName(value) {
  const safe = sanitizeAIText(value || 'Unknown');
  if (!safe || safe === 'Unknown') return 'Unknown';
  return safe
    .split(/\s+/)
    .map((part) => {
      if (part.length <= 3) return `${part[0] || ''}***`;
      return `${part.slice(0, 2)}***${part.slice(-2)}`;
    })
    .join(' ');
}

function money(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return `KSh ${Math.round(amount).toLocaleString('en-KE')}`;
}

function txAmount(tx) {
  const amount = Number(tx?.amount);
  return Number.isFinite(amount) ? amount : 0;
}

function txCategory(tx) {
  if (tx?.category) return tx.category;
  if (tx?.type === 'bundle') return 'airtime';
  if (tx?.type === 'airtime') return 'airtime';
  if (tx?.type === 'send') return 'transfers';
  const text = `${tx?.name || ''} ${tx?.note || ''}`.toLowerCase();
  if (/bolt|matatu|uber|ride|transport/.test(text)) return 'transport';
  if (/naivas|food|kfc|java|restaurant/.test(text)) return 'food';
  if (/power|water|utility|kplc/.test(text)) return 'utilities';
  if (/bundle|data|airtime|safaricom/.test(text)) return 'airtime';
  if (/shop|zara|mall/.test(text)) return 'shopping';
  if (/m-shwari|saving/.test(text)) return 'savings';
  return 'other';
}

function summarizeTransaction(tx) {
  const amount = txAmount(tx);
  const label = CATEGORY_LABELS[txCategory(tx)] || 'Other';
  const status = tx?.status ? sanitizeAIText(tx.status).toLowerCase() : 'completed';
  const direction = amount >= 0 ? 'in' : 'out';
  return `${label} ${direction} ${money(Math.abs(amount)) || 'KSh 0'} with ${maskName(tx?.name || tx?.merchant || tx?.recipient || tx?.type)} (${status})`;
}

function categoryTotals(txHistory, budgetSpend) {
  const totals = {};
  const safeTx = Array.isArray(txHistory) ? txHistory : [];
  safeTx.forEach((tx) => {
    const amount = Math.abs(txAmount(tx));
    if (!amount) return;
    const category = txCategory(tx);
    totals[category] = (totals[category] || 0) + amount;
  });

  if (!Object.keys(totals).length) {
    Object.entries(budgetSpend || {}).forEach(([key, value]) => {
      const amount = Number(value);
      if (Number.isFinite(amount) && amount > 0) totals[key] = amount;
    });
  }

  return totals;
}

function latestBundleStatus(txHistory) {
  const safeTx = Array.isArray(txHistory) ? txHistory : [];
  const latest = safeTx.find((tx) => /bundle|data/i.test(`${tx?.type || ''} ${tx?.name || ''} ${tx?.note || ''}`));
  if (latest) {
    return `last bundle activity was ${money(Math.abs(txAmount(latest))) || 'KSh 0'} for ${maskName(latest.name || 'bundle')}`;
  }
  const stored = readJson(typeof sessionStorage !== 'undefined' ? sessionStorage : null, 'zuri_bundle_status', null);
  if (stored?.label || stored?.remaining) {
    return sanitizeAIText(`${stored.label || 'bundle'} ${stored.remaining || ''} ${stored.expires || ''}`.trim());
  }
  return 'not available';
}

function latestAirtimeStatus(txHistory) {
  const safeTx = Array.isArray(txHistory) ? txHistory : [];
  const latest = safeTx.find((tx) => /airtime/i.test(`${tx?.type || ''} ${tx?.name || ''} ${tx?.note || ''}`));
  if (latest) return `last airtime activity was ${money(Math.abs(txAmount(latest))) || 'KSh 0'}`;
  const stored = readJson(typeof sessionStorage !== 'undefined' ? sessionStorage : null, 'zuri_airtime_status', null);
  if (stored?.balance) return sanitizeAIText(`balance ${money(stored.balance) || stored.balance}`);
  return 'not available';
}

function getBiometricEnabled(user) {
  const id = user?.id || user?.email;
  if (!id || typeof localStorage === 'undefined') return false;
  return Boolean(readString(localStorage, `biometric_cred_id_${id}`, ''));
}

function getRiskShieldStatus() {
  const store = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  return sanitizeAIText(readString(store, 'risk_shield_status', 'active')) || 'active';
}

export function buildSafeAIContext({
  user,
  txHistory = [],
  availableBalance,
  currentPage = 'Duke AI chat',
  conversationMessages = [],
  budgetSpend,
  budgetLimits = DEFAULT_LIMITS,
} = {}) {
  const safeBudgetSpend = budgetSpend || getCategorySpend();
  const totals = categoryTotals(txHistory, safeBudgetSpend);
  const topCategories = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([key, amount]) => ({ key, label: CATEGORY_LABELS[key] || key, amount }));

  const overspendCategories = Object.entries(safeBudgetSpend)
    .map(([key, spent]) => ({
      key,
      label: CATEGORY_LABELS[key] || key,
      spent: Number(spent) || 0,
      limit: Number(budgetLimits?.[key]) || 0,
    }))
    .filter((cat) => cat.limit > 0 && cat.spent > cat.limit)
    .map((cat) => ({ ...cat, overBy: cat.spent - cat.limit }));

  const safeTx = Array.isArray(txHistory) && txHistory.length ? txHistory : TRANSACTIONS;
  const failedPending = safeTx.filter((tx) => /failed|pending|processing|timeout/i.test(String(tx?.status || ''))).length;
  const pending = safeTx.filter((tx) => /pending|processing/i.test(String(tx?.status || ''))).length;
  const failed = safeTx.filter((tx) => /failed|timeout|cancel/i.test(String(tx?.status || ''))).length;

  const safeBalance = typeof availableBalance === 'number'
    ? money(availableBalance)
    : sanitizeAIText(availableBalance || 'unavailable');

  const safeContext = {
    displayFirstName: getFirstNameForGreeting(user?.full_name || user?.email),
    currentPage: sanitizeAIText(currentPage || 'Duke AI chat'),
    availableBalance: safeBalance,
    topSpendingCategories: topCategories,
    budgetCategorySpend: Object.entries(safeBudgetSpend || {})
      .filter(([, amount]) => Number(amount) > 0)
      .map(([key, amount]) => ({ key, label: CATEGORY_LABELS[key] || key, amount: Number(amount) || 0 }))
      .sort((a, b) => b.amount - a.amount),
    recentTransactionCount: safeTx.length,
    recentFailedPendingPaymentsCount: failedPending,
    pendingPaymentsCount: pending,
    failedPaymentsCount: failed,
    budgetLimits: Object.fromEntries(Object.entries(budgetLimits || {}).map(([key, limit]) => [CATEGORY_LABELS[key] || key, Number(limit) || 0])),
    overspendCategories,
    biometricEnabled: getBiometricEnabled(user),
    riskShieldStatus: getRiskShieldStatus(),
    bundleStatus: latestBundleStatus(txHistory),
    airtimeStatus: latestAirtimeStatus(txHistory),
    safeRecentTransactions: safeTx.slice(0, 3).map(summarizeTransaction),
    conversationMessages: sanitizeConversationMessages(conversationMessages),
    monthlyTrend: MONTHLY_TREND.slice(-2),
  };

  return safeContext;
}

export function formatSafeContextForPrompt(context) {
  const top = context.topSpendingCategories
    ?.map((cat) => `${cat.label}: ${money(cat.amount)}`)
    .join(', ') || 'no spending data';
  const over = context.overspendCategories
    ?.map((cat) => `${cat.label} over by ${money(cat.overBy)} (spent ${money(cat.spent)} / limit ${money(cat.limit)})`)
    .join(', ') || 'none';
  const txs = context.safeRecentTransactions?.join('; ') || 'none';
  const budget = context.budgetCategorySpend
    ?.map((cat) => `${cat.label}: ${money(cat.amount)}`)
    .join(', ') || 'no budget category data';
  const memory = context.conversationMessages
    ?.map((msg) => `${msg.role}: ${msg.content}`)
    .join(' | ') || 'none';

  return [
    `Current page: ${context.currentPage}`,
    `Customer first name: ${context.displayFirstName}`,
    `Available balance: ${context.availableBalance}`,
    `Top spending categories: ${top}`,
    `Budget category spend: ${budget}`,
    `Recent transactions counted: ${context.recentTransactionCount}`,
    `Recent failed/pending payments: ${context.recentFailedPendingPaymentsCount}`,
    `Overspend categories: ${over}`,
    `Biometric enabled: ${context.biometricEnabled ? 'yes' : 'no'}`,
    `Risk Shield status: ${context.riskShieldStatus}`,
    `Bundle status: ${context.bundleStatus}`,
    `Airtime status: ${context.airtimeStatus}`,
    `Last safe transaction summaries: ${txs}`,
    `Last safe chat messages: ${memory}`,
  ].join('\n');
}

function repeatAwarePrefix(message, conversationMessages = []) {
  const normalized = sanitizeAIText(message).toLowerCase();
  const previousSame = conversationMessages
    .filter((msg) => msg.role === 'user')
    .slice(0, -1)
    .some((msg) => sanitizeAIText(msg.content).toLowerCase() === normalized);
  return previousSame ? 'Building on the answer above: ' : '';
}

export function detectLocalIntent(message) {
  const lower = String(message || '').toLowerCase();
  if (/spend most|spent most|highest spend|biggest spend|what did i spend/.test(lower)) return 'top_spend';
  if (/how can i save|save more|reduce spending|cut cost|save money/.test(lower)) return 'savings';
  if (/am i at risk|risk|safe|security|scam|fraud/.test(lower)) return 'risk';
  if (/check.*bundle|bundle status|data.*left|data balance/.test(lower)) return 'bundle';
  if (/why.*payment.*fail|payment.*failed|failed payment/.test(lower)) return 'payment_failed';
  if (/pending payment|show pending|awaiting|processing payment/.test(lower)) return 'pending_payments';
  if (/what should i do next|next step|next action|do next/.test(lower)) return 'next_step';
  return null;
}

export function classifyDukeIntent(message) {
  const lower = String(message || '').toLowerCase();
  if (/\b(reveal|show|tell|give|share|bypass|disable|change|reset|verify|enroll|mutate|execute|post|mark)\b.*\b(otp|pin|password|secret|jwt|service role|api key|biometric|ledger|payment successful|payment completed)\b/i.test(lower)) {
    return 'unsupported_sensitive_action';
  }
  if (/scam|fraud|risk|security|safe|phish|biometric|protect|freeze|suspicious/.test(lower)) return 'fraud_security';
  if (/send money|transfer|paybill|till|lipa na mpesa|payment|transaction failed|pending payment|mpesa|m-pesa|fuliza/.test(lower)) return 'mpesa_payment_help';
  if (/bundle|airtime|data|internet|gb|mb|safaricom/.test(lower)) return 'bundle_airtime';
  if (/budget|spend|spent|saving|save|expense|balance|shopping|transport|food|cost/.test(lower)) return 'finance_budget';
  if (/where|open|go to|navigate|show me|find.*page|which tab|app|screen/.test(lower)) return 'app_navigation';
  return 'general_chat';
}

export function isFinanceIntent(intent) {
  return ['finance_budget', 'mpesa_payment_help', 'bundle_airtime', 'fraud_security'].includes(intent);
}

export function buildLocalInsight(message, context) {
  const intent = detectLocalIntent(message);
  if (!intent || !context) return null;
  const prefix = repeatAwarePrefix(message, context.conversationMessages);
  const top = context.topSpendingCategories?.[0];
  const second = context.topSpendingCategories?.[1];
  const overspend = context.overspendCategories?.[0];
  const latest = context.safeRecentTransactions?.[0];

  if (intent === 'top_spend' && top) {
    return `${prefix}You spent the most on ${top.label}: ${money(top.amount)}. ${second ? `${second.label} was next at ${money(second.amount)}. ` : ''}${overspend ? `${overspend.label} is over budget by ${money(overspend.overBy)}, so that is the first place I would tighten.` : 'No budget category is over limit in the data I can see.'}`;
  }

  if (intent === 'savings') {
    if (overspend) {
      return `${prefix}Start with ${overspend.label}: it is over by ${money(overspend.overBy)} after spending ${money(overspend.spent)} against a ${money(overspend.limit)} limit. Cap the next few ${overspend.label.toLowerCase()} purchases, then review ${top?.label || 'your top category'} before buying another bundle or paybill top-up.`;
    }
    return `${prefix}Your biggest visible spend is ${top?.label || 'not clear yet'}${top ? ` at ${money(top.amount)}` : ''}. Set a daily cap, keep bundles monthly instead of repeated small buys, and move savings first before discretionary M-PESA spends.`;
  }

  if (intent === 'risk') {
    const status = context.riskShieldStatus || 'active';
    const biometric = context.biometricEnabled ? 'enabled' : 'not enabled';
    return `${prefix}Risk Shield is ${status}, biometrics are ${biometric}, and I see ${context.recentFailedPendingPaymentsCount} recent failed or pending payment${context.recentFailedPendingPaymentsCount === 1 ? '' : 's'}. If a caller asks for OTP, PIN, or reversal help, stop and call Safaricom 100 from your line.`;
  }

  if (intent === 'bundle') {
    if (context.bundleStatus && context.bundleStatus !== 'not available') {
      return `${prefix}I can see ${context.bundleStatus}. I do not have live Safaricom network access here, so confirm in Bundles before buying.`;
    }
    return `${prefix}I do not have a live bundle balance in this safe context. Your airtime/data budget spend is visible, so open Bundles to confirm remaining MB or choose a monthly bundle before another small top-up.`;
  }

  if (intent === 'payment_failed') {
    return `${prefix}I see ${context.failedPaymentsCount} failed payment${context.failedPaymentsCount === 1 ? '' : 's'} in the safe summary. The usual causes are wrong PIN, insufficient balance, network timeout, or provider confirmation delay. Review the latest item${latest ? ` (${latest})` : ''} and retry only through the secure payment screen.`;
  }

  if (intent === 'pending_payments') {
    return `${prefix}I see ${context.pendingPaymentsCount} pending payment${context.pendingPaymentsCount === 1 ? '' : 's'} in the safe summary. Do not retry immediately if M-PESA confirmation may still arrive; check History first, then wait for backend confirmation or a failed status before trying again.`;
  }

  if (intent === 'next_step') {
    if (overspend) {
      return `${prefix}Next: pause ${overspend.label.toLowerCase()} spending until it is back under the ${money(overspend.limit)} budget, then review any pending payments before sending more money.`;
    }
    return `${prefix}Next: check pending payments, keep Risk Shield on, and set a small cap on ${top?.label || 'your top spending category'} for the rest of the week.`;
  }

  return null;
}

export function buildContextualFallback(message, context) {
  const intent = classifyDukeIntent(message);
  const local = buildLocalInsight(message, context);
  if (local) return `${nextFallbackPrefix('finance')}${local}`;
  const top = context?.topSpendingCategories?.[0];
  const overspend = context?.overspendCategories?.[0];
  if (isFinanceIntent(intent) && overspend) {
    return `${nextFallbackPrefix('finance')}${overspend.label} is over by ${money(overspend.overBy)} and ${top?.label || 'your top category'} is your largest spend.`;
  }
  if (isFinanceIntent(intent) && top) {
    return `${nextFallbackPrefix('finance')}${top.label} is your largest visible spend at ${money(top.amount)}.`;
  }
  return nextFallbackPrefix('general');
}

const FALLBACK_VARIANTS = {
  finance: [
    "Here's what I can tell from your app data: ",
    'From the safe Zuri summary I can see: ',
    'Using your local app context: ',
  ],
  general: [
    "I'm having trouble reaching the full AI service, but I can still help with Zuri features, budgeting, M-PESA safety, and app navigation.",
    'The full AI service is not responding right now. I can still guide you around Zuri, budgets, M-PESA safety, and common app tasks.',
    'I do not want to fake a cloud answer. I can still help with Zuri features and safe finance guidance from the app.',
  ],
};

function nextFallbackPrefix(kind) {
  const variants = FALLBACK_VARIANTS[kind] || FALLBACK_VARIANTS.general;
  try {
    const key = `zuri_ai_fallback_${kind}_variant`;
    const current = Number(sessionStorage.getItem(key) || '0');
    sessionStorage.setItem(key, String((current + 1) % variants.length));
    return variants[current % variants.length];
  } catch {
    return variants[0];
  }
}

export function buildBudgetLocalInsights({ spend = getCategorySpend(), limits = DEFAULT_LIMITS } = {}) {
  const totals = Object.entries(spend || {})
    .map(([key, amount]) => ({ key, label: CATEGORY_LABELS[key] || key, amount: Number(amount) || 0, limit: Number(limits[key]) || 0 }))
    .filter((cat) => cat.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  const top = totals[0];
  const overspend = totals.find((cat) => cat.limit > 0 && cat.amount > cat.limit);
  const airtime = totals.find((cat) => cat.key === 'airtime');
  const transportMay = MONTHLY_TREND.find((row) => row.month === 'May')?.transport;
  const transportApr = MONTHLY_TREND.find((row) => row.month === 'Apr')?.transport;

  const parts = [];
  if (top) parts.push(`${top.label} is your largest May category at ${money(top.amount)}.`);
  if (overspend) parts.push(`${overspend.label} is over budget by ${money(overspend.amount - overspend.limit)}.`);
  if (airtime) parts.push(`Airtime/Data is at ${money(airtime.amount)}, so monthly bundles may beat repeated small top-ups.`);
  if (transportApr && transportMay && transportMay < transportApr) parts.push(`Transport is down ${money(transportApr - transportMay)} versus April.`);
  return parts.join(' ') || 'No budget spend is available yet. Add transactions or limits to unlock Duke AI budget guidance.';
}

export function buildBudgetPrompt({ spend = getCategorySpend(), limits = DEFAULT_LIMITS } = {}) {
  const spendSummary = Object.entries(spend || {})
    .filter(([, val]) => Number(val) > 0)
    .map(([key, val]) => `${CATEGORY_LABELS[key] || key}: ${money(val)}`)
    .join(', ') || 'No spending data';
  const limitsSummary = Object.entries(limits || {})
    .map(([key, val]) => `${CATEGORY_LABELS[key] || key}: ${money(val)}`)
    .join(', ');
  const localSummary = buildBudgetLocalInsights({ spend, limits });

  return `You are Duke AI, the financial copilot for Zuri Connect Africa. Use only this safe budget summary; do not ask for PIN, OTP, full phone, tokens, or raw ledger rows.
Current page: Budget Insights.
Spending: ${spendSummary}.
Budget limits: ${limitsSummary}.
Calculated local insight: ${localSummary}
Answer directly with 2-3 concise, practical Kenyan/Safaricom/M-PESA relevant tips. Use KSh amounts where available. Max 90 words. Plain text, no markdown bullets.`;
}
