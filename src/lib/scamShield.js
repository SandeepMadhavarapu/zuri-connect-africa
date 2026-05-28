/**
 * Zuri Connect Africa — Scam Shield Engine
 * Telecom-grade behavioral fraud detection.
 * Internal scoring is NEVER exposed publicly.
 */

import { getDeviceInfo } from './deviceTrust';

// ── Internal signal dictionaries ─────────────────────────────────────────────

const URGENCY_PHRASES = [
  'haraka', 'sasa hivi', 'emergency', 'urgent', 'accident', 'hospital',
  'dying', 'immediately', 'leo tu', 'life or death', 'please hurry',
  'right now', 'now now', 'hurry up', 'critical', 'please fast',
];

const LOTTERY_PHRASES = [
  'umeshinda', 'winner', 'prize', 'claim', 'deposit first',
  'processing fee', 'refundable', 'congratulations', 'reward',
  'hongera umepata', 'you have won', 'lucky winner', 'selected',
  'sweepstake', 'lottery', 'cash prize',
];

const REVERSAL_PHRASES = [
  'sent by mistake', 'wrong number', 'please refund', 'nilikosea',
  'return', 'refund', 'send back', 'rudisha', 'nilikutumia kwa makosa',
];

// ── Adaptive memory (session-scoped) ─────────────────────────────────────────

const _memory = (() => {
  try {
    const raw = sessionStorage.getItem('_zca_bm');
    return raw ? JSON.parse(raw) : { cancelCount: 0, verifiedCount: 0 };
  } catch { return { cancelCount: 0, verifiedCount: 0 }; }
})();

function _saveMemory() {
  try { sessionStorage.setItem('_zca_bm', JSON.stringify(_memory)); } catch {}
}

export function recordUserCancelledWarning() {
  _memory.cancelCount = (_memory.cancelCount || 0) + 1;
  _saveMemory();
}

export function recordUserVerifiedSafe() {
  _memory.verifiedCount = (_memory.verifiedCount || 0) + 1;
  _saveMemory();
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function _countMatches(text, phrases) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  return phrases.filter(p => lower.includes(p)).length;
}

function _matchedPhrases(text, phrases) {
  if (!text) return [];
  const lower = text.toLowerCase();
  return phrases.filter(p => lower.includes(p));
}

function _isSuspiciousPrefix(phone) {
  if (!phone) return false;
  const clean = phone.replace(/\s+/g, '').replace(/^\+254/, '0');
  return /^(0700|0701|0702|0703)/.test(clean);
}

function _isRoundNumber(amount) {
  return amount % 500 === 0 || amount % 1000 === 0;
}

function _isNightTime(hour) {
  return hour >= 23 || hour < 5;
}

// ── Scam graph heuristic ─────────────────────────────────────────────────────

function _scamGraphSignal(recipientHistory, recipientVelocity) {
  if (!recipientHistory) return 0;
  let score = 0;
  if (recipientVelocity >= 5) score += 30;
  else if (recipientVelocity >= 3) score += 15;
  if (recipientHistory.uniqueSenders >= 4) score += 20;
  if (recipientHistory.avgRelationshipAgeHours < 2) score += 20;
  return Math.min(score, 60);
}

// ── Main analysis function ───────────────────────────────────────────────────

export function analyzeTransaction({
  amount = 0,
  recipientPhone = '',
  recipientName = '',
  userMessage = '',
  recentFailedAttempts = 0,
  isNewRecipient = false,
  timeOfDay = new Date().getHours(),
  daysSinceLastTxToRecipient = Infinity,
  avgUserTransactionAmount = 1000,
  txCountLastHour = 0,
  deviceTrustScore: passedTrustScore = null,
  sessionAgeMinutes = 60,
  geoChanged = false,
  recipientHistory = null,
  recipientVelocity = 0,
} = {}) {

  // ── Internal accumulators (NEVER returned) ──────────────────────────────
  let _internalRisk = 0;
  let _authScore = 0;
  const signals = [];

  // Adaptive sensitivity from memory
  const sensitivityBoost = Math.min((_memory.cancelCount || 0) * 5, 20);
  const sensitivityReduction = Math.min((_memory.verifiedCount || 0) * 3, 10);
  const adaptiveDelta = sensitivityBoost - sensitivityReduction;

  // 1. Urgency manipulation
  const urgencyCount = _countMatches(userMessage, URGENCY_PHRASES);
  const urgencyMatched = _matchedPhrases(userMessage, URGENCY_PHRASES);
  if (urgencyCount >= 2) {
    _internalRisk += 40 + adaptiveDelta;
    _authScore += 20;
    signals.push('Urgency pressure detected in message');
    if (isNewRecipient) _internalRisk += 25;
  } else if (urgencyCount === 1) {
    _internalRisk += 15 + adaptiveDelta;
    signals.push('Urgency language noted');
  }

  // 2. Lottery / prize scam
  const lotteryCount = _countMatches(userMessage, LOTTERY_PHRASES);
  if (lotteryCount >= 1) {
    _internalRisk += 90;
    signals.push('Prize or lottery scam pattern detected');
  }

  // 3. Reversal scam
  const reversalCount = _countMatches(userMessage, REVERSAL_PHRASES);
  if (reversalCount >= 1 && isNewRecipient && _isRoundNumber(amount)) {
    _internalRisk += 55;
    signals.push('Reversal scam pattern — new recipient requesting refund');
  }

  // 4. Impersonation risk
  if (_isSuspiciousPrefix(recipientPhone) && isNewRecipient && amount >= 2000) {
    _internalRisk += 20;
    signals.push('Unknown number with unfamiliar prefix');
  }

  // 5. Amount spike
  if (avgUserTransactionAmount > 0 && amount >= avgUserTransactionAmount * 5) {
    _internalRisk += 35 + adaptiveDelta;
    _authScore += 30;
    signals.push('Transaction amount significantly above your usual pattern');
  } else if (avgUserTransactionAmount > 0 && amount >= avgUserTransactionAmount * 3) {
    _internalRisk += 20;
    _authScore += 15;
    signals.push('Transaction amount above your typical range');
  }

  // 6. Night time risk
  if (_isNightTime(timeOfDay)) {
    _internalRisk += 15 + adaptiveDelta;
    signals.push('Late-night transaction detected');
  }

  // 7. Velocity check
  if (txCountLastHour >= 5) {
    _internalRisk += 35;
    _authScore += 25;
    signals.push('Unusually high number of transactions in the last hour');
  } else if (txCountLastHour >= 3) {
    _internalRisk += 18;
    _authScore += 12;
    signals.push('Multiple transactions detected recently');
  }

  // 8. Device trust
  let deviceScore = passedTrustScore;
  if (deviceScore === null) {
    const deviceInfo = getDeviceInfo();
    deviceScore = deviceInfo.isTrusted ? 80 : 50;
  }
  if (deviceScore < 30) {
    _authScore += 40;
    _internalRisk += 25;
    signals.push('Unrecognized device environment');
  } else if (deviceScore < 60) {
    _authScore += 20;
    _internalRisk += 10;
    signals.push('Device trust requires additional verification');
  }

  if (geoChanged) {
    _internalRisk += 20;
    _authScore += 20;
    signals.push('Location change detected since last session');
  }

  if (sessionAgeMinutes < 2) {
    _internalRisk += 10;
    _authScore += 10;
    signals.push('Session started very recently');
  }

  // 9. Recipient behavior
  if (isNewRecipient && amount >= 5000) {
    _internalRisk += 20;
    signals.push('First-time transfer to this recipient');
  }
  if (daysSinceLastTxToRecipient > 180 && amount >= 3000) {
    _internalRisk += 10;
    signals.push('No recent transaction history with this recipient');
  }

  // 10. Scam graph
  const graphSignal = _scamGraphSignal(recipientHistory, recipientVelocity);
  if (graphSignal >= 40) {
    _internalRisk += graphSignal;
    signals.push('This number has shown unusual receiving behavior. Please verify carefully before sending money.');
  } else if (graphSignal > 15) {
    _internalRisk += graphSignal;
    signals.push('Recipient has received from multiple new senders recently');
  }

  // 11. Failed attempts
  if (recentFailedAttempts >= 3) {
    _internalRisk += 20;
    _authScore += 15;
    signals.push('Multiple recent failed transaction attempts');
  }

  // ── Determine outcome ─────────────────────────────────────────────────────

  const isLotteryScam = lotteryCount >= 1;
  const isHighRisk = _internalRisk >= 80;
  const isMedRisk = _internalRisk >= 40;
  const needsAuth = _authScore >= 30 || deviceScore < 40;

  const shouldBlock = isLotteryScam || (isHighRisk && isNewRecipient);
  const shouldWarn = !shouldBlock && isMedRisk;

  const requiresPin = !shouldBlock && (_authScore >= 30 || recentFailedAttempts >= 2);
  const requiresFaceAuth = !shouldBlock && (_authScore >= 50 || deviceScore < 40 || geoChanged);
  const requiresVoiceAuth = !shouldBlock && (_authScore >= 70 || (isNewRecipient && amount >= 10000));

  // ── Natural language output (NO scores exposed) ──────────────────────────

  let warningTitle = '';
  let warningMessage = '';
  let swahiliMessage = '';
  let recommendation = '';
  let educationTip = '';

  if (isLotteryScam) {
    warningTitle = 'Scam Alert — Do Not Send';
    warningMessage = "This message contains patterns used by prize and lottery scammers. Real prizes, organizations, or promotions never ask you to send money first. This transaction has been paused for your protection.";
    swahiliMessage = "Ujumbe huu una dalili za ulaghai wa tuzo na bahati nasibu. Tuzo halisi hazihitaji kulipa pesa kwanza. Muamala huu umesimamishwa kwa usalama wako.";
    recommendation = "Do not send money. Report this number to Safaricom on *100# if someone is pressuring you.";
    educationTip = "Prize scams ask for a small 'processing fee' before releasing your 'winnings'. There are no winnings — only losses.";
  } else if (isHighRisk && isNewRecipient) {
    warningTitle = 'Transaction Paused';
    warningMessage = "We've detected several unusual signals on this transaction. The combination of a new recipient, the message content, and your recent activity pattern requires careful review before proceeding.";
    swahiliMessage = "Tumegundua ishara kadhaa za kutia wasiwasi kwenye muamala huu. Inahitaji ukaguzi makini kabla ya kuendelea.";
    recommendation = "Call the recipient directly on a trusted number before sending. Do not proceed based on messages alone.";
    educationTip = "Scammers often impersonate people you trust. Always call to verify before sending large amounts.";
  } else if (urgencyCount >= 2) {
    warningTitle = 'Pressure Tactics Detected';
    warningMessage = "The message accompanying this transaction uses urgency pressure — a common tactic in phone scams. Legitimate emergencies don't require you to make instant payment decisions.";
    swahiliMessage = "Ujumbe huu unatumia mbinu za shinikizo za dharura — mbinu inayotumika sana na walaghai. Dharura za kweli hazikusanidi kulipa haraka haraka.";
    recommendation = "Take 60 seconds. Call the person directly. Verify before you send.";
    educationTip = "If someone is rushing you to send money, that urgency is the scam. Real emergencies allow time to verify.";
  } else if (reversalCount >= 1 && isNewRecipient) {
    warningTitle = 'Possible Reversal Scam';
    warningMessage = "Someone may be asking you to return money they claim to have sent you by mistake. This is a known M-PESA scam — the original transfer may have been fraudulent or never occurred.";
    swahiliMessage = "Mtu anaweza kukuomba kurudisha pesa wanazodai walikutumia kwa makosa. Hii ni ulaghai unaojulikana wa M-PESA.";
    recommendation = "Check your M-PESA statement directly. Never send money based on a message alone. Call Safaricom on 100 to verify.";
    educationTip = "In the 'wrong number' scam, criminals send you money using stolen funds, then ask you to return it to a different account.";
  } else if (graphSignal >= 40) {
    warningTitle = 'Recipient Flagged';
    warningMessage = "This number has shown unusual receiving behavior from multiple unrelated people in a short period. Please verify carefully that you know and trust this person before sending money.";
    swahiliMessage = "Nambari hii imeonyesha tabia ya kushangaza ya kupokea pesa kutoka kwa watu wengi wasiohusiana katika muda mfupi. Hakikisha unajua na kumwamini mtu huyu.";
    recommendation = "Speak to the recipient directly using a number you have stored independently — not one they just sent you.";
    educationTip = "Scammers use 'mule accounts' that receive money from many victims. The account owner may not even know their number is being used.";
  } else if (_isNightTime(timeOfDay) && amount >= 5000) {
    warningTitle = 'Unusual Timing';
    warningMessage = "You're sending a significant amount late at night. While this may be intentional, late-night transactions are sometimes triggered by social engineering. Please confirm this is expected.";
    swahiliMessage = "Unatuma kiasi kikubwa usiku wa manane. Tafadhali thibitisha kuwa hii ni muamala uliokusudiwa.";
    recommendation = "If you're being pressured by someone online or via message, pause and sleep on it. Scammers rely on late-night urgency.";
    educationTip = "Financial fraud peaks between midnight and 5am when victims are tired and less alert.";
  } else if (isMedRisk) {
    warningTitle = 'Please Verify Before Sending';
    warningMessage = "Some aspects of this transaction are outside your normal patterns. Please take a moment to confirm you're sending to the right person and for the right reason.";
    swahiliMessage = "Baadhi ya mambo ya muamala huu yako nje ya mfumo wako wa kawaida. Tafadhali thibitisha kuwa unatuma kwa mtu sahihi.";
    recommendation = "Double-check the recipient's name and number. If in doubt, call them directly.";
    educationTip = "Always confirm a recipient's full name matches who you intend to pay before sending money.";
  }

  return {
    shouldWarn,
    shouldBlock,
    requiresPin,
    requiresFaceAuth,
    requiresVoiceAuth,
    warningTitle,
    warningMessage,
    swahiliMessage,
    recommendation,
    educationTip,
    triggeredSignals: signals,
  };
}