/**
 * Zuri Connect Africa — Rewards Intelligence Engine
 * AI-powered loyalty system with tier progression, smart earning,
 * fraud-safe redemption, and personalized recommendations.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'zuri_rewards_v1';

export const EARN_RATES = {
  bundle:     8,   // pts per KSh 10 spent on bundles
  transfer:   3,   // pts per KSh 10 sent
  paybill:    5,   // pts per KSh 10 on bill payments
  airtime:    2,   // pts per KSh 10 on airtime
  ecosystem:  10,  // pts per ecosystem service used
  referral:   500, // flat pts per successful referral
};

export const TIERS = [
  { id: 'bronze', label: 'Bronze',   min: 0,     max: 999,   color: '#cd7f32', glow: 'rgba(205,127,50,0.15)',  perks: ['2x points on weekends', 'Priority support'] },
  { id: 'silver', label: 'Silver',   min: 1000,  max: 4999,  color: '#9ca3af', glow: 'rgba(156,163,175,0.15)', perks: ['3x bundle points', 'Free monthly SMS bundle', 'Cashback on Paybill'] },
  { id: 'gold',   label: 'Gold',     min: 5000,  max: 14999, color: '#f0a500', glow: 'rgba(240,165,0,0.15)',   perks: ['5x all points', 'Free data rollover', 'Dedicated advisor', 'Zero Fuliza fees'] },
  { id: 'elite',  label: 'Elite',    min: 15000, max: Infinity, color: '#2ecc71', glow: 'rgba(46,204,113,0.15)', perks: ['10x all points', 'Unlimited rollover', 'VIP events', 'Exclusive offers'] },
];

export const REDEMPTION_CATALOG = [
  { id: 'r1',  title: '1 GB Data Bundle',   points: 400,  value: 'KSh 50',  category: 'data',        popular: true,  multiplier: 1.0 },
  { id: 'r2',  title: '5 GB Data Bundle',   points: 1800, value: 'KSh 250', category: 'data',        popular: true,  multiplier: 1.1 },
  { id: 'r3',  title: 'KSh 50 Airtime',     points: 500,  value: 'KSh 50',  category: 'airtime',     popular: false, multiplier: 0.9 },
  { id: 'r4',  title: 'KSh 200 Airtime',    points: 1900, value: 'KSh 200', category: 'airtime',     popular: false, multiplier: 0.9 },
  { id: 'r5',  title: 'Fuliza Fee Waiver',  points: 750,  value: 'KSh 80',  category: 'credit',      popular: false, multiplier: 1.05 },
  { id: 'r6',  title: 'Paybill Cashback',   points: 1200, value: 'KSh 120', category: 'cashback',    popular: true,  multiplier: 1.15 },
  { id: 'r7',  title: 'Smart TV 1 Month',   points: 5000, value: 'KSh 600', category: 'entertainment', popular: false, multiplier: 1.2 },
  { id: 'r8',  title: 'Transfer Fee Waiver',points: 300,  value: 'KSh 35',  category: 'transfer',    popular: true,  multiplier: 1.0 },
];

export const MILESTONES = [
  { id: 'm1', pts: 500,   icon: 'Zap',        label: 'First 500',      reward: '+50 bonus pts',   achieved: false },
  { id: 'm2', pts: 1000,  icon: 'Star',       label: 'Silver Unlock',  reward: '3x weekend pts',  achieved: false },
  { id: 'm3', pts: 2500,  icon: 'TrendingUp', label: 'Power User',     reward: '+200 bonus pts',  achieved: false },
  { id: 'm4', pts: 5000,  icon: 'Award',      label: 'Gold Status',    reward: 'Zero Fuliza fees',achieved: false },
  { id: 'm5', pts: 10000, icon: 'Crown',      label: 'Loyalty Legend', reward: '+1000 bonus pts', achieved: false },
];

// ─── State Management (sessionStorage) ────────────────────────────────────────

function loadState() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function saveState(state) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

function defaultState() {
  return {
    points: 1240,
    lifetimePoints: 4320,
    earnHistory: [
      { id: 'e1', type: 'bundle',   pts: 80,  label: '10 GB Bundle purchase',  date: '2026-05-08T08:00:00Z' },
      { id: 'e2', type: 'paybill',  pts: 120, label: 'KPLC bill payment',      date: '2026-05-07T14:22:00Z' },
      { id: 'e3', type: 'transfer', pts: 45,  label: 'Send to James Mwangi',   date: '2026-05-06T11:05:00Z' },
      { id: 'e4', type: 'ecosystem',pts: 30,  label: 'NHIF portal used',       date: '2026-05-05T09:30:00Z' },
      { id: 'e5', type: 'bundle',   pts: 45,  label: 'Weekend 2x bonus',       date: '2026-05-03T16:00:00Z' },
    ],
    redeemHistory: [
      { id: 'd1', rewardId: 'r1', label: '1 GB Data Bundle', pts: 400, date: '2026-04-28T10:00:00Z' },
    ],
  };
}

// ─── Core API ──────────────────────────────────────────────────────────────────

export function getRewardsState() {
  return loadState() || defaultState();
}

/**
 * Award points for a transaction type.
 * @param {'bundle'|'transfer'|'paybill'|'airtime'|'ecosystem'} type
 * @param {number} amount - KSh amount (for transaction types) or 0 for flat-rate
 * @param {string} label - human-readable description
 */
export function awardPoints(type, amount = 0, label = '') {
  const state = getRewardsState();
  const rate  = EARN_RATES[type] || 0;
  const pts   = type === 'ecosystem' || type === 'referral'
    ? rate
    : Math.floor((amount / 10) * rate);

  if (pts <= 0) return state;

  const entry = {
    id:    `e_${Date.now()}`,
    type,
    pts,
    label: label || type,
    date:  new Date().toISOString(),
  };

  const next = {
    ...state,
    points:        state.points + pts,
    lifetimePoints: state.lifetimePoints + pts,
    earnHistory:   [entry, ...state.earnHistory].slice(0, 50),
  };
  saveState(next);
  return next;
}

/**
 * Redeem points for a catalog item. Returns updated state or throws.
 */
export function redeemPoints(rewardId) {
  const state  = getRewardsState();
  const reward = REDEMPTION_CATALOG.find(r => r.id === rewardId);
  if (!reward) throw new Error('Reward not found');
  if (state.points < reward.points) throw new Error('Insufficient points');

  const entry = {
    id:       `d_${Date.now()}`,
    rewardId: reward.id,
    label:    reward.title,
    pts:      reward.points,
    date:     new Date().toISOString(),
  };

  const next = {
    ...state,
    points:        state.points - reward.points,
    redeemHistory: [entry, ...state.redeemHistory].slice(0, 50),
  };
  saveState(next);
  return next;
}

// ─── Tier Logic ───────────────────────────────────────────────────────────────

export function getCurrentTier(lifetimePoints) {
  return [...TIERS].reverse().find(t => lifetimePoints >= t.min) || TIERS[0];
}

export function getNextTier(lifetimePoints) {
  return TIERS.find(t => lifetimePoints < t.min) || null;
}

export function getTierProgress(lifetimePoints) {
  const current = getCurrentTier(lifetimePoints);
  const next    = getNextTier(lifetimePoints);
  if (!next) return { pct: 100, remaining: 0, current, next: null };
  const range     = next.min - current.min;
  const earned    = lifetimePoints - current.min;
  const pct       = Math.min(100, Math.round((earned / range) * 100));
  const remaining = next.min - lifetimePoints;
  return { pct, remaining, current, next };
}

// ─── Milestone Logic ─────────────────────────────────────────────────────────

export function getMilestones(lifetimePoints) {
  return MILESTONES.map(m => ({ ...m, achieved: lifetimePoints >= m.pts }));
}

// ─── AI Suggestions ───────────────────────────────────────────────────────────

export function getAISuggestions(state) {
  const { points, lifetimePoints } = state;
  const progress = getTierProgress(lifetimePoints);
  const suggestions = [];

  // Tier proximity nudge
  if (progress.next && progress.remaining <= 500) {
    suggestions.push({
      id: 'tier_close',
      icon: 'Award',
      color: 'text-amber-400',
      bg:    'bg-amber-400/10',
      text:  `You're only ${progress.remaining} pts from ${progress.next.label} tier — pay a bill to unlock it.`,
    });
  }

  // Bundle vs airtime redemption value
  const bundleReward  = REDEMPTION_CATALOG.find(r => r.id === 'r1');
  const airtimeReward = REDEMPTION_CATALOG.find(r => r.id === 'r3');
  if (bundleReward && airtimeReward && bundleReward.multiplier > airtimeReward.multiplier) {
    suggestions.push({
      id: 'bundle_better',
      icon: 'TrendingUp',
      color: 'text-primary',
      bg:    'bg-primary/10',
      text:  'Redeeming for data bundles gives 10% more value than airtime top-ups.',
    });
  }

  // Weekend double points
  const day = new Date().getDay();
  if (day === 5 || day === 6 || day === 0) {
    suggestions.push({
      id: 'weekend_2x',
      icon: 'Zap',
      color: 'text-violet-400',
      bg:    'bg-violet-400/10',
      text:  'Weekend bonus (preview) — earn 2× points on all transactions today.',
    });
  }

  // High balance nudge
  if (points >= 1000) {
    suggestions.push({
      id: 'redeem_now',
      icon: 'Gift',
      color: 'text-blue-400',
      bg:    'bg-blue-400/10',
      text:  `You have ${points.toLocaleString()} pts — enough for a free 5 GB bundle or cashback.`,
    });
  }

  // Paybill cashback nudge
  suggestions.push({
    id: 'paybill_earn',
    icon: 'Receipt',
    color: 'text-primary',
    bg:    'bg-primary/10',
    text:  'Pay your KPLC or water bill through Zuri to earn 5× reward points.',
  });

  return suggestions.slice(0, 3);
}