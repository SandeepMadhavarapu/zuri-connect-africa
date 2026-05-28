/**
 * Zuri Connect Africa — AI Orchestrator
 * Single entry point for all AI requests.
 * Routes to the optimal provider per request type, enforces safety,
 * manages memory, logs observability, and handles failover.
 */

import { withFailover }        from './failover';
import { screenMessage }       from './safety';
import { detectLanguage, getLanguageInstruction } from './languageDetection';
import { pushConversationContext, setLanguage, recordRecommendation } from './memory';
import {
  buildContextualFallback,
  buildLocalInsight,
  buildSafeAIContext,
  classifyDukeIntent,
  formatSafeContextForPrompt,
  sanitizeConversationMessages,
} from './contextBuilder';
import { audit }  from '../auditLogger';
import { emit }                from '../eventBus';

// ─── Request type → provider preference + system prompt ──────────────────────

// Assistant persona — kept in sync with src/lib/branding/aiBrand.js (Duke AI).
// The model is instructed to identify as "Duke AI" so user-facing chat copy
// stays consistent with the rest of the product brand. Behaviour (provider
// routing, safety, language detection, failover, observability) is unchanged.
const ASSISTANT_PERSONA = 'Duke AI, the financial copilot for Zuri Connect Africa (a Safaricom-scale fintech platform in Kenya)';
const CAPABILITY_BRIEF = [
  'Allowed capabilities:',
  '- Explain balances, spending, budgets, bundles, failed/pending payments, and security posture from safe summaries.',
  '- Propose payments, airtime, bundle, reversal, or security actions only as reviewable proposals.',
  '- Sensitive and financial actions always require user confirmation and step-up where policy says so.',
  '- Never execute payments, mutate ledgers, reveal secrets, or claim payment completion without server-confirmed status.',
].join('\n');

const RESPONSE_STYLE_BRIEF = [
  'Response style:',
  '- You are Duke AI, Zuri Connect Africa\'s financial and security copilot.',
  '- You can also answer general questions naturally when they are safe.',
  '- Be conversational, useful, confident, and specific.',
  '- Answer the current question directly; do not repeat the generic intro after the first message.',
  '- Do not always mention budget if it is irrelevant.',
  '- Use specific KSh amounts from context when available and do not invent numbers.',
  '- Ask at most one clarifying question when needed.',
  '- Use short paragraphs.',
  '- Keep guidance practical for Kenya, Safaricom, and M-PESA.',
  '- If the user repeats a question, acknowledge the prior answer and add a new next step.',
].join('\n');

const ROUTE_CONFIG = {
  financial_coach: {
    provider: 'openai',
    systemBase: `You are ${ASSISTANT_PERSONA}. Help users with M-PESA, budgeting, savings, and financial planning. Be concise, warm, and expert. Never guarantee financial outcomes. Never claim to be a human if directly asked. Support English, Swahili, and Sheng naturally.`,
  },
  fraud_detection: {
    provider: 'anthropic',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a financial safety guide. Educate users about M-PESA scams, fraud patterns, and how to protect their money. Be calm, clear, and non-alarmist. Never disclose internal fraud scoring. Always advise calling Safaricom 100 for emergencies.`,
  },
  scam_analysis: {
    provider: 'anthropic',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a scam prevention specialist. Analyse potential scam scenarios described by the user and explain what warning signs are present. Be educational, not alarming. Recommend the user report to Safaricom 100 or DCI Kenya.`,
  },
  telecom_support: {
    provider: 'gemini',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a telecom technical support guide. Help users with network issues, bundle problems, SIM issues, and connectivity. Be practical and step-by-step. Do not claim access to real carrier-level data.`,
  },
  spending_analysis: {
    provider: 'openai',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a spending coach for Kenyan M-PESA users. Analyse transaction patterns, identify overspending, and suggest practical savings. Use real transaction context provided. Never fabricate numbers.`,
  },
  bundle_recommendation: {
    provider: 'gemini',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a data bundle advisor for Kenyan mobile users. Recommend the best bundles based on usage patterns. Be specific with package names and prices relevant to Kenya. Do not invent packages that don't exist.`,
  },
  network_assistant: {
    provider: 'gemini',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a network health guide. Help users understand signal issues, congestion, and connectivity problems. Provide practical steps. You do NOT have access to real-time carrier data — base your advice on general troubleshooting and ask the user to describe their symptoms.`,
  },
  rewards_assistant: {
    provider: 'openai',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a loyalty rewards advisor. Help users maximise their points, understand tier benefits, and choose the best redemptions. Be encouraging and specific.`,
  },
  security_assistant: {
    provider: 'anthropic',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a digital security advisor for mobile money users in Kenya. Help users understand authentication, device security, and account protection. Be clear and never alarmist. Recommend Safaricom 100 for account emergencies.`,
  },
  ai_actions: {
    provider: 'openai',
    systemBase: `You are ${ASSISTANT_PERSONA}, acting as a fintech action assistant. Confirm and explain actions the user wants to take — buying bundles, sending money, freezing wallets, or reporting scams. Be clear about what will happen before any action is taken.`,
  },
  voice_assistant: {
    provider: 'openai',
    systemBase: `You are ${ASSISTANT_PERSONA}, speaking out loud through a voice interface. Keep responses brief, clear, and conversational — they will be spoken aloud. Avoid markdown or lists. Respond in the user's language.`,
  },
  general: {
    provider: 'openai',
    systemBase: `You are ${ASSISTANT_PERSONA}, and you can also answer normal general questions naturally. Help with coding, travel, school, business, planning, writing, and everyday questions when safe. For medical, legal, or high-stakes financial advice, give general guidance and recommend a qualified professional where appropriate. Support English, Swahili, and Sheng.`,
  },
};

const INTENT_ROUTE = {
  general_chat: 'general',
  finance_budget: 'spending_analysis',
  mpesa_payment_help: 'financial_coach',
  bundle_airtime: 'bundle_recommendation',
  fraud_security: 'security_assistant',
  app_navigation: 'general',
  unsupported_sensitive_action: 'security_assistant',
};

// ─── Observability log ────────────────────────────────────────────────────────

const OBS_KEY = 'zuri_ai_obs_v1';

function logObservability(entry) {
  try {
    const log = JSON.parse(sessionStorage.getItem(OBS_KEY) || '[]');
    log.unshift(entry);
    sessionStorage.setItem(OBS_KEY, JSON.stringify(log.slice(0, 50)));
  } catch {}
}

export function getObservabilityLog() {
  try { return JSON.parse(sessionStorage.getItem(OBS_KEY) || '[]'); } catch { return []; }
}

function normalizeAIActionResponse(response) {
  if (!response) return null;
  if (typeof response === 'object' && response.type && response.message) return response;
  if (typeof response !== 'string') return null;
  const text = response.trim();
  if (!text.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.type && parsed.message ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Main router ──────────────────────────────────────────────────────────────

/**
 * Route an AI request through safety → language detection → provider → response.
 *
 * @param {object} opts
 * @param {string} opts.type       - request type (see ROUTE_CONFIG keys)
 * @param {object} opts.user       - authenticated user object
 * @param {string} opts.message    - raw user message
 * @param {object} [opts.context]  - extra context (txHistory, balanceStr, etc.)
 * @param {object} [opts.metadata] - arbitrary metadata
 * @returns {Promise<{ response, provider, latency, fallbackTriggered, language }>}
 */
export async function routeAIRequest({ type = 'general', user, message, context = {}, metadata = {} }) {
  const requestStart = Date.now();
  const requestId = `ai_${crypto.randomUUID()}`;

  // 1. Safety screen
  const safety = screenMessage(message, user?.id || user?.email);
  if (!safety.safe) {
    logObservability({ requestId, type, provider: 'safety_block', latency: 0, fallbackTriggered: false, safe: false, threat: safety.threat, ts: Date.now() });
    return { response: safety.refusal, provider: 'safety', latency: 0, fallbackTriggered: false, language: 'en', blocked: true };
  }

  // 2. Detect language
  const lang = detectLanguage(message);
  setLanguage(lang);
  pushConversationContext({ type, lang, ts: Date.now() });

  // 3. Build system prompt
  const dukeIntent = classifyDukeIntent(message);
  const effectiveType = type === 'general' || !type ? (INTENT_ROUTE[dukeIntent] || 'general') : type;
  const config     = ROUTE_CONFIG[effectiveType] || ROUTE_CONFIG.general;
  const langInstr  = getLanguageInstruction(lang);
  const safeConversation = sanitizeConversationMessages(context.conversationMessages || []);
  const safeContext = buildSafeAIContext({
    user,
    txHistory: context.txHistory,
    availableBalance: context.availableBalance ?? context.balance,
    currentPage: context.currentPage || metadata.currentPage || 'Duke AI chat',
    conversationMessages: safeConversation,
    budgetSpend: context.budgetSpend,
    budgetLimits: context.budgetLimits,
  });
  const ctxSummary = formatSafeContextForPrompt(safeContext);
  const localInsight = buildLocalInsight(message, safeContext);
  const systemPrompt = [
    config.systemBase,
    RESPONSE_STYLE_BRIEF,
    CAPABILITY_BRIEF,
    `Language instruction: ${langInstr}`,
    'Safe financial context:',
    ctxSummary,
    'Session memory summary:',
    safeContext.conversationMessages.length ? safeContext.conversationMessages.map((msg) => `${msg.role}: ${msg.content}`).join(' | ') : 'none',
    `Message classification: ${dukeIntent}`,
    localInsight ? `Local deterministic insight to respect: ${localInsight}` : 'Local deterministic insight: none',
  ].join('\n\n');

  const payload = {
    systemPrompt,
    userMessage: message,
    context: [
      context.extra ? `Page note: ${context.extra}` : '',
      ctxSummary,
      localInsight ? `Local answer candidate: ${localInsight}` : '',
    ].filter(Boolean).join('\n\n'),
    safeContext,
    localInsight,
    useInternet: config.useInternet || false,
  };

  // 4. Route with failover
  let result = await withFailover(payload, config.provider);

  const actionResponse = normalizeAIActionResponse(result.response);
  if (actionResponse) {
    result = {
      ...result,
      response: actionResponse.message,
      actionResponse,
      aiResponseType: actionResponse.type,
      proposed_action: actionResponse.proposed_action,
      blocked: actionResponse.type === 'blocked',
    };
  }

  if (result.error && !result.response) {
    result.response = buildContextualFallback(message, safeContext);
  }
  if (result.authError) {
    result.response = 'Please sign in again so Duke AI can respond securely.';
  }
  if (result.rateLimited) {
    // Use the precise wait time when the server provided one; otherwise the
    // generic cooldown message. Never retry here — the UI guards subsequent
    // sends and the user must wait.
    const seconds = Number(result.retryAfterSeconds);
    if (Number.isFinite(seconds) && seconds > 0) {
      const minutes = Math.max(1, Math.round(seconds / 60));
      const wait = seconds < 60
        ? `about ${Math.max(5, seconds)} seconds`
        : `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
      result.response = `Duke AI is cooling down for a moment. Try again in ${wait}.`;
    } else {
      result.response = 'Duke AI is cooling down for a moment. Try again shortly.';
    }
  }

  // 5. Observability
  const obsEntry = {
    requestId,
    type: effectiveType,
    dukeIntent,
    provider:          result.provider,
    latency:           result.latency,
    fallbackTriggered: result.fallbackTriggered,
    language:          lang,
    success:           !result.error,
    ts:                Date.now(),
    userId:            user?.email || 'anonymous',
  };
  logObservability(obsEntry);

  // 6. Emit to event bus for dashboards
  try { emit('AI_REQUEST_COMPLETED', obsEntry); } catch {}

  // 7. Log critical failures to audit trail
  if (result.error) {
    try { audit.atoSignal('ai_provider_failure', `type=${type} fallback=${result.provider}`, user?.email); } catch {}
  }

  // 8. Record recommendation if applicable
  if (['bundle_recommendation', 'spending_analysis', 'rewards_assistant'].includes(type)) {
    recordRecommendation(type, result.response?.slice(0, 100));
  }

  return { ...result, language: lang };
}
