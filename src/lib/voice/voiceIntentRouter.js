/**
 * Zuri Connect Africa — Voice Intent Router
 * Maps spoken phrases to AI request types and navigation targets.
 */

import { normalizeFintechPhrase } from '../ai/languageDetection';
import { AI_BRAND } from '../branding/aiBrand';

const INTENT_ROUTES = {
  balance_query: { type: 'financial_coach',   path: '/',         label: 'Check Balance' },
  fraud_query:   { type: 'fraud_detection',   path: '/security', label: 'Report Fraud' },
  network_query: { type: 'network_assistant', path: '/network',  label: 'Network' },
  history_query: { type: 'spending_analysis', path: '/history',  label: 'Transactions' },
  wallet_query:  { type: 'financial_coach',   path: '/wallet',   label: 'Wallet' },
  schedule_query:{ type: 'financial_coach',   path: '/schedules',label: 'Standing Orders' },
  general:       { type: 'financial_coach',   path: '/ai',       label: AI_BRAND.voiceFallbackLabel },
};

export function routeVoiceIntent(transcript) {
  const intent = normalizeFintechPhrase(transcript);
  return {
    intent,
    ...INTENT_ROUTES[intent] || INTENT_ROUTES.general,
  };
}