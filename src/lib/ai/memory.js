/**
 * Zuri Connect Africa — AI Memory System
 * Session-scoped context store for personalized AI behavior.
 * NEVER stores PINs, biometrics, raw voice data, tokens, or secrets.
 */

const KEY = 'zuri_ai_memory_v1';

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
function save(mem) {
  try { sessionStorage.setItem(KEY, JSON.stringify(mem)); } catch {}
}

const defaults = () => ({
  preferredLanguage: 'en',          // en | sw | sheng | mixed
  bundleHabits: [],                 // ['daily_1gb', 'weekly_10gb']
  spendingPatterns: {},             // { category: avgKsh }
  financialGoals: [],               // ['save_5000', 'reduce_airtime']
  fraudWarningsShown: [],           // [{ type, ts }]
  telecomPatterns: {},              // { peakHour, preferredNetwork }
  aiRecommendationHistory: [],      // [{ type, text, ts, acted }]
  conversationContext: [],          // last N intents for continuity
  lastActivity: null,
});

export function getMemory() {
  const stored = load();
  return { ...defaults(), ...stored };
}

export function setLanguage(lang) {
  const m = getMemory(); m.preferredLanguage = lang; save(m);
}

export function recordBundleHabit(bundleType) {
  const m = getMemory();
  if (!m.bundleHabits.includes(bundleType)) m.bundleHabits = [bundleType, ...m.bundleHabits].slice(0, 10);
  m.lastActivity = Date.now(); save(m);
}

export function recordSpendingPattern(category, amount) {
  const m = getMemory();
  m.spendingPatterns[category] = amount;
  m.lastActivity = Date.now(); save(m);
}

export function addFinancialGoal(goal) {
  const m = getMemory();
  if (!m.financialGoals.includes(goal)) m.financialGoals = [goal, ...m.financialGoals].slice(0, 5);
  save(m);
}

export function recordFraudWarning(type) {
  const m = getMemory();
  m.fraudWarningsShown = [{ type, ts: Date.now() }, ...m.fraudWarningsShown].slice(0, 20);
  save(m);
}

export function recordRecommendation(type, text) {
  const m = getMemory();
  m.aiRecommendationHistory = [{ type, text, ts: Date.now(), acted: false }, ...m.aiRecommendationHistory].slice(0, 30);
  save(m);
}

export function markRecommendationActed(type) {
  const m = getMemory();
  const idx = m.aiRecommendationHistory.findIndex(r => r.type === type && !r.acted);
  if (idx !== -1) m.aiRecommendationHistory[idx].acted = true;
  save(m);
}

export function pushConversationContext(intent) {
  const m = getMemory();
  m.conversationContext = [intent, ...m.conversationContext].slice(0, 8);
  m.lastActivity = Date.now(); save(m);
}

export function buildContextSummary(user, txHistory) {
  const m = getMemory();
  const spend = Object.entries(m.spendingPatterns)
    .map(([k, v]) => `${k}: KSh ${v}`).join(', ') || 'no data';
  const goals = m.financialGoals.join(', ') || 'none set';
  const lang  = m.preferredLanguage;
  const warns = m.fraudWarningsShown.length;
  const recent = txHistory?.slice(0, 4).map(t =>
    `${t.type} ${t.amount > 0 ? '+' : ''}KSh${Math.abs(t.amount)} (${t.name})`
  ).join(', ') || 'none';

  return `User: ${user?.full_name || 'Customer'} | Lang pref: ${lang} | Spending: ${spend} | Goals: ${goals} | Recent txs: ${recent} | Fraud warnings shown: ${warns}`;
}

export function clearMemory() {
  sessionStorage.removeItem(KEY);
}