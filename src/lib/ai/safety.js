/**
 * Zuri Connect Africa — AI Safety Layer
 * Detects and blocks PIN harvesting, OTP phishing, impersonation,
 * prompt injection, jailbreaks, and social engineering.
 */

import { emit, EVENTS } from '../eventBus';
import { audit, SEVERITY } from '../auditLogger';

// ─── Pattern banks ────────────────────────────────────────────────────────────

const PIN_PATTERNS = [
  /what('?s| is) (your |my |the )?pin/i,
  /share (your |my )?pin/i,
  /enter (your |my )?pin/i,
  /tell me (your |my )?pin/i,
  /send (your |the )?pin/i,
  /confirm (your |the )?pin/i,
  /pin (number|code|digits)/i,
];

const OTP_PATTERNS = [
  /what('?s| is) (the |your |my )?otp/i,
  /share (the |your )?otp/i,
  /send (me |the )?otp/i,
  /(one.?time.?password|verification code)/i,
  /mpesa (code|pin|verification)/i,
];

const IMPERSONATION_PATTERNS = [
  /i('?m| am) (from |calling from )?(safaricom|mpesa|zuri|the bank|central bank)/i,
  /safaricom (agent|official|support|customer care)/i,
  /mpesa (agent|support|official)/i,
  /bank (official|agent|representative)/i,
  /calling from the (government|police|cid)/i,
];

const INJECTION_PATTERNS = [
  /ignore (previous|all|above|prior) (instructions?|prompt|rules?|context)/i,
  /forget (everything|your instructions|all previous)/i,
  /you are (now |)?a (different|new|evil|unrestricted|jailbroken)/i,
  /pretend (you are|to be) (a )?different/i,
  /act as (if )?you (have no|don't have|ignore) (restrictions?|rules?|safety)/i,
  /system prompt|<system>|<<SYS>>/i,
  /\[INST\]|\[\/INST\]|###instruction/i,
  /bypass|jailbreak|dan mode|dev mode/i,
];

const SCAM_INSTRUCTION_PATTERNS = [
  /help (me )?scam/i,
  /how (do i|to) (steal|hack|phish|defraud)/i,
  /teach (me )?how to (commit fraud|steal money|phish)/i,
  /create a (fake|phishing|scam)/i,
  /send money (to a |the )?wrong number (scam|trick)/i,
];

// ─── Classifier ───────────────────────────────────────────────────────────────

export function classifyThreat(message) {
  if (!message) return null;

  if (PIN_PATTERNS.some(p => p.test(message)))          return 'pin_harvesting';
  if (OTP_PATTERNS.some(p => p.test(message)))          return 'otp_phishing';
  if (IMPERSONATION_PATTERNS.some(p => p.test(message)))return 'impersonation';
  if (INJECTION_PATTERNS.some(p => p.test(message)))    return 'prompt_injection';
  if (SCAM_INSTRUCTION_PATTERNS.some(p => p.test(message))) return 'scam_instruction';

  return null;
}

// ─── Safe refusal responses ───────────────────────────────────────────────────

const REFUSALS = {
  pin_harvesting:  "I can't help with that. Sharing your M-PESA PIN with anyone — including Zuri — is never safe. If someone is asking for your PIN, that is a scam. Call Safaricom on 100 immediately.",
  otp_phishing:    "I won't share or request OTP codes. One-Time Passwords are private and should never be shared. If you received an unexpected OTP, do not share it with anyone.",
  impersonation:   "Zuri and Safaricom will never ask you to share your PIN or OTP over a call or chat. If someone claiming to be from Safaricom or Zuri is asking for personal codes, hang up and call 100.",
  prompt_injection:"That request doesn't look right. I'm here to help with your finances — let me know what you'd like to do.",
  scam_instruction:"I'm not able to assist with that. If you've been affected by a scam, I can help you report it and protect your account.",
};

/**
 * Screen a message before sending to an AI provider.
 * Returns { safe: true } or { safe: false, threat, refusal }
 */
export function screenMessage(message, userId) {
  const threat = classifyThreat(message);
  if (!threat) return { safe: true };

  // Log and emit
  try {
    audit.atoSignal('ai_safety_block', threat, userId || 'anonymous');
    emit('FRAUD_FLAGGED', { threat, source: 'ai_safety', userId });
  } catch {}

  return {
    safe:    false,
    threat,
    refusal: REFUSALS[threat] || "I can't help with that request.",
  };
}