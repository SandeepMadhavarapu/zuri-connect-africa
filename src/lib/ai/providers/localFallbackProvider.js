/**
 * Local Fallback Provider
 * Offline-safe contextual engine. It never pretends to be a cloud model and
 * only uses already-sanitized summaries passed in by the orchestrator.
 */

import { buildContextualFallback, buildLocalInsight } from '../contextBuilder';

const RESPONSES = {
  bundle:   'I cannot see live Safaricom bundle data here. Check Bundles before buying, and prefer a monthly bundle if you keep making small data top-ups.',
  airtime:  'I cannot see a live airtime balance here. Top up only after checking your balance in Airtime, and keep the amount within your monthly Airtime/Data budget.',
  balance:  'Your M-PESA balance is available in the home screen. Tap the eye icon to reveal it.',
  send:     'I can help prepare a send-money review, but I cannot send money directly. Use the Send screen so confirmation, risk checks, and step-up verification still run.',
  fuliza:   'Your Fuliza overdraft limit is KSh 5,000. You can access it automatically when your balance is insufficient.',
  fraud:    'If you suspect fraud, immediately freeze your wallet in Security Centre and call Safaricom on 100.',
  scam:     'Common scams include wrong-number reversals, fake prize messages, and emergency calls. Never share your PIN or OTP with anyone.',
  history:  'Your recent transactions are visible in the History section. Tap any transaction for details.',
  budget:   'You can set spending budgets by category in the Budget section and track your progress monthly.',
  network:  'For network issues, try switching to 4G or restarting your phone. You can check network status in the app.',
  rewards:  'You have 1,240 Zuri Points. Visit the Rewards section to see what you can redeem.',
  paybill:  'You can pay bills for KPLC, Nairobi Water, NHIF, and more in the Paybill section.',
  security: 'Your account is protected with multi-factor authentication. Review your security settings in Security Centre.',
  default:  "I'm here to help with your M-PESA finances. You can ask me about your balance, transactions, bundles, airtime, or security.",
};

const FALLBACK_PREFIXES = [
  "Here's what I can tell from your app data: ",
  'From the safe Zuri summary I can see: ',
  'Using your local app context: ',
];

function matchKeyword(message) {
  const lower = String(message || '').toLowerCase();
  if (/bundle|data|internet|gb|mb/.test(lower)) return 'bundle';
  if (/airtime|credit|simu|minutes/.test(lower)) return 'airtime';
  if (/balance|salio|kiasi/.test(lower)) return 'balance';
  if (/send|tuma|transfer|nitumie/.test(lower)) return 'send';
  if (/fuliza|borrow|overdraft/.test(lower)) return 'fuliza';
  if (/fraud|scam|steal|hack|phish/.test(lower)) return 'fraud';
  if (/scam|ujanja|udanganyifu/.test(lower)) return 'scam';
  if (/history|transactions|shughuli/.test(lower)) return 'history';
  if (/budget|spend|expense/.test(lower)) return 'budget';
  if (/network|signal|mtandao|4g|wifi/.test(lower)) return 'network';
  if (/reward|points|bonga/.test(lower)) return 'rewards';
  if (/paybill|bill|kplc|water|nhif/.test(lower)) return 'paybill';
  if (/security|safe|protect/.test(lower)) return 'security';
  return 'default';
}

function nextPrefix() {
  try {
    const key = 'zuri_ai_local_fallback_variant';
    const current = Number(sessionStorage.getItem(key) || '0');
    sessionStorage.setItem(key, String((current + 1) % FALLBACK_PREFIXES.length));
    return FALLBACK_PREFIXES[current % FALLBACK_PREFIXES.length];
  } catch {
    return FALLBACK_PREFIXES[0];
  }
}

export async function generateResponse({ userMessage, safeContext, localInsight }) {
  const key = matchKeyword(userMessage || '');
  await new Promise((resolve) => setTimeout(resolve, 180));

  const contextual = localInsight || buildLocalInsight(userMessage, safeContext);
  if (contextual) return `${nextPrefix()}${contextual}`;

  if (safeContext) return buildContextualFallback(userMessage, safeContext);

  return RESPONSES[key] || RESPONSES.default;
}
