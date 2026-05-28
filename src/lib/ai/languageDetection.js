/**
 * Zuri Connect Africa — Kenyan Language Intelligence
 * Detects English, Swahili, Sheng, and mixed Kenyan slang.
 * Used to tailor AI response tone and language.
 */

// Sheng / Swahili signal words
const SHENG_SIGNALS = [
  'niaje', 'sema', 'maze', 'bana', 'fam', 'msee', 'dame', 'kama', 'aje',
  'si', 'jo', 'uko', 'niko', 'naomba', 'sawa', 'poa', 'tu', 'ata',
  'wacha', 'ngoja', 'nini', 'vipi', 'mbona', 'kwani', 'leo', 'jana',
  'haraka', 'pole', 'mkubwa', 'wadau', 'watu', 'hela', 'pesa',
  'thao', 'mia', 'kitu', 'cheki', 'angalia', 'shida', 'tatizo',
];

const SWAHILI_SIGNALS = [
  'tuma', 'nipe', 'nitumie', 'niambie', 'ningependa', 'tafadhali',
  'asante', 'habari', 'karibu', 'samahani', 'naomba', 'ninaweza',
  'imenilock', 'imeisha', 'zimeisha', 'inakataa', 'imefail',
  'fedha', 'akaunti', 'salio', 'malipo', 'lipa', 'nunua',
  'data', 'bundles', 'airtime', 'fuliza', 'okoa', 'jahazi',
];

const FINTECH_SWAHILI = [
  'fuliza imenilock', 'bundles zimeisha', 'nipe thao', 'nitumie thao',
  'niaje na account', 'pesa hazijafika', 'imetumwa lakini', 'mzigo wangu',
  'airtme imeisha', 'data imeisha', 'okoa jahazi',
];

/**
 * Detect the primary language of a message.
 * @returns {'en' | 'sw' | 'sheng' | 'mixed'}
 */
export function detectLanguage(message) {
  if (!message || typeof message !== 'string') return 'en';
  const lower = message.toLowerCase().trim();
  const words = lower.split(/\s+/);

  // Check for fintech Swahili phrases first (high confidence)
  for (const phrase of FINTECH_SWAHILI) {
    if (lower.includes(phrase)) return 'sheng';
  }

  let shengScore   = 0;
  let swahiliScore = 0;

  for (const word of words) {
    if (SHENG_SIGNALS.includes(word))   shengScore++;
    if (SWAHILI_SIGNALS.includes(word)) swahiliScore++;
  }

  const total = words.length || 1;
  const shengRatio   = shengScore / total;
  const swahiliRatio = swahiliScore / total;

  if (shengRatio > 0.15 && swahiliRatio > 0.05) return 'mixed';
  if (shengRatio > 0.1)   return 'sheng';
  if (swahiliRatio > 0.1) return 'sw';

  // Check for mixed signals even at lower threshold
  if (shengScore > 0 && swahiliScore > 0) return 'mixed';
  if (shengScore > 0)   return 'sheng';
  if (swahiliScore > 0) return 'sw';

  return 'en';
}

/**
 * Build a language instruction for the AI system prompt.
 */
export function getLanguageInstruction(lang) {
  switch (lang) {
    case 'sw':
      return 'Respond in clear, natural Swahili. Be professional and helpful.';
    case 'sheng':
      return 'Respond in a natural mix of English and Sheng — conversational, warm, and direct. Avoid being cringe or exaggerated.';
    case 'mixed':
      return 'The user is mixing English and Swahili/Sheng. Match their tone — respond in a natural bilingual style that feels genuine, not forced.';
    default:
      return 'Respond in clear, professional English.';
  }
}

/**
 * Normalize a Kenyan fintech phrase to a standard intent for routing.
 */
export function normalizeFintechPhrase(message) {
  const lower = message.toLowerCase();
  const map = [
    [/nitumie|tuma|send/,          'send_money'],
    [/bundle|data|internet/,       'bundle_query'],
    [/fuliza|borrow|overdraft/,    'fuliza_query'],
    [/airtime|credit|simu/,        'airtime_query'],
    [/salio|balance|kiasi/,        'balance_query'],
    [/paybill|lipa|bili|kplc|maji/,'paybill_query'],
    [/scam|fraud|ujanja|udanganyifu/, 'fraud_query'],
    [/bonga|points|rewards/,       'rewards_query'],
    [/network|signal|mtandao/,     'network_query'],
    [/history|transactions|shughuli/, 'history_query'],
  ];
  for (const [pattern, intent] of map) {
    if (pattern.test(lower)) return intent;
  }
  return 'general';
}