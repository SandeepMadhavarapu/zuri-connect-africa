/**
 * Zuri Connect Africa — Voice Intent Router
 * Maps spoken phrases to AI request types and navigation targets.
 */

import { normalizeFintechPhrase } from '../ai/languageDetection';
import { AI_BRAND } from '../branding/aiBrand';

const INTENT_ROUTES = {
  send_money:    { type: 'ai_actions',           path: '/send',     label: 'Send Money' },
  bundle_query:  { type: 'bundle_recommendation',path: '/bundles',  label: 'Buy Bundle' },
  fuliza_query:  { type: 'financial_coach',      path: '/fuliza',   label: 'Fuliza' },
  airtime_query: { type: 'financial_coach',      path: '/airtime',  label: 'Buy Airtime' },
  balance_query: { type: 'financial_coach',      path: '/',         label: 'Check Balance' },
  paybill_query: { type: 'ai_actions',           path: '/paybill',  label: 'Pay Bill' },
  fraud_query:   { type: 'fraud_detection',      path: '/security', label: 'Report Fraud' },
  rewards_query: { type: 'rewards_assistant',    path: '/bonga',    label: 'Rewards' },
  network_query: { type: 'network_assistant',    path: '/network',  label: 'Network' },
  history_query: { type: 'spending_analysis',    path: '/history',  label: 'Transactions' },
  general:       { type: 'financial_coach',      path: '/ai',       label: AI_BRAND.voiceFallbackLabel },
};

export function routeVoiceIntent(transcript) {
  const intent = normalizeFintechPhrase(transcript);
  return {
    intent,
    ...INTENT_ROUTES[intent] || INTENT_ROUTES.general,
  };
}