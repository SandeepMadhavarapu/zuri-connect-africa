/**
 * Zuri Connect Africa — Adaptive Quick Actions Engine
 * Learns from usage patterns, time-of-day, and recency.
 */

import {
  ArrowUpRight, ArrowDownLeft, Phone, Wifi,
  CreditCard, CalendarClock, Zap, Wallet,
  Shield, Sparkles, Gift, BarChart2, BookOpen,
} from 'lucide-react';
import { AI_BRAND } from '@/lib/branding/aiBrand';

const STORAGE_KEY = 'zuri_quick_actions_v1';

export const CATEGORIES = ['All', 'Transact', 'Bundles', 'Airtime', 'Bills', 'Security', 'Rewards', 'AI Tools'];

export const DEFAULT_QUICK_ACTIONS = [
  { id: 'send',      label: 'Send',       icon: 'ArrowUpRight',  color: 'text-primary',      bg: 'bg-primary/10',      path: '/send',      category: 'Transact', pinned: false, usageCount: 0, lastUsed: null },
  { id: 'receive',   label: 'Receive',    icon: 'ArrowDownLeft', color: 'text-blue-400',     bg: 'bg-blue-400/10',     path: '/receive',   category: 'Transact', pinned: false, usageCount: 0, lastUsed: null },
  { id: 'airtime',   label: 'Airtime',    icon: 'Phone',         color: 'text-amber-400',    bg: 'bg-amber-400/10',    path: '/airtime',   category: 'Airtime',  pinned: false, usageCount: 0, lastUsed: null },
  { id: 'bundles',   label: 'Bundles',    icon: 'Wifi',          color: 'text-violet-400',   bg: 'bg-violet-400/10',   path: '/bundles',   category: 'Bundles',  pinned: false, usageCount: 0, lastUsed: null },
  { id: 'paybill',   label: 'Paybill',    icon: 'CreditCard',    color: 'text-primary',      bg: 'bg-primary/10',      path: '/paybill',   category: 'Bills',    pinned: false, usageCount: 0, lastUsed: null },
  { id: 'schedules', label: 'Standing',   icon: 'CalendarClock', color: 'text-orange-400',   bg: 'bg-orange-400/10',   path: '/schedules', category: 'Bills',    pinned: false, usageCount: 0, lastUsed: null },
  { id: 'fuliza',    label: 'Fuliza',     icon: 'Zap',           color: 'text-amber-400',    bg: 'bg-amber-400/10',    path: '/fuliza',    category: 'Transact', pinned: false, usageCount: 0, lastUsed: null },
  { id: 'wallet',    label: 'M-PESA',     icon: 'Wallet',        color: 'text-primary',      bg: 'bg-primary/10',      path: '/wallet',    category: 'Transact', pinned: false, usageCount: 0, lastUsed: null },
  { id: 'security',  label: 'Security',   icon: 'Shield',        color: 'text-primary',      bg: 'bg-primary/10',      path: '/security',  category: 'Security', pinned: false, usageCount: 0, lastUsed: null },
  { id: 'ai',        label: AI_BRAND.quickActionLabel, icon: 'Sparkles',      color: 'text-violet-400',   bg: 'bg-violet-400/10',   path: '/ai',        category: 'AI Tools', pinned: false, usageCount: 0, lastUsed: null },
  ...(import.meta.env.VITE_ALLOW_INTERNAL_PAGES === 'true' ? [
    { id: 'bonga', label: 'Bonga', icon: 'Gift', color: 'text-amber-400', bg: 'bg-amber-400/10', path: '/bonga', category: 'Rewards', pinned: false, usageCount: 0, lastUsed: null },
  ] : []),
  { id: 'budget',    label: 'Budget',     icon: 'BarChart2',     color: 'text-blue-400',     bg: 'bg-blue-400/10',     path: '/budget',    category: 'AI Tools', pinned: false, usageCount: 0, lastUsed: null },
];

// Icon map for serialization (we store icon names, not components)
export const ICON_MAP = {
  ArrowUpRight, ArrowDownLeft, Phone, Wifi, CreditCard,
  CalendarClock, Zap, Wallet, Shield, Sparkles, Gift, BarChart2, BookOpen,
};

export function getQuickActions() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUICK_ACTIONS.map(a => ({ ...a }));
    const saved = JSON.parse(raw);
    // Merge: add any new defaults not yet in saved
    const savedIds = new Set(saved.map(a => a.id));
    const merged = [...saved];
    for (const def of DEFAULT_QUICK_ACTIONS) {
      if (!savedIds.has(def.id)) merged.push({ ...def });
    }
    return merged;
  } catch {
    return DEFAULT_QUICK_ACTIONS.map(a => ({ ...a }));
  }
}

export function saveQuickActions(actions) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(actions));
  } catch {}
}

export function recordActionUsage(actionId) {
  const actions = getQuickActions();
  const updated = actions.map(a =>
    a.id === actionId
      ? { ...a, usageCount: (a.usageCount || 0) + 1, lastUsed: Date.now() }
      : a
  );
  saveQuickActions(updated);
  return updated;
}

export function pinQuickAction(actionId, pinned) {
  const actions = getQuickActions();
  const updated = actions.map(a => a.id === actionId ? { ...a, pinned } : a);
  saveQuickActions(updated);
  return updated;
}

export function reorderQuickActions(actions) {
  saveQuickActions(actions);
  return actions;
}

/**
 * Scoring algorithm for recommendations:
 * - Usage count (most used)
 * - Recency (last used within 24h)
 * - Time-of-day patterns
 */
export function getRecommendedActions(allActions, limit = 3) {
  const now = Date.now();
  const hour = new Date().getHours();

  // Time-of-day bias
  const timeBonus = (action) => {
    if (hour >= 7 && hour < 10 && action.id === 'airtime') return 15;
    if (hour >= 12 && hour < 14 && action.id === 'send') return 10;
    if (hour >= 18 && hour < 21 && action.id === 'bundles') return 15;
    if (hour >= 21 && action.id === 'budget') return 10;
    return 0;
  };

  const scored = allActions.map(a => {
    let score = (a.usageCount || 0) * 10;
    // Recency boost: used in last 24h
    if (a.lastUsed && now - a.lastUsed < 86_400_000) score += 20;
    // Used in last hour
    if (a.lastUsed && now - a.lastUsed < 3_600_000) score += 30;
    score += timeBonus(a);
    // Pinned items excluded (already shown)
    if (a.pinned) score = -1;
    return { ...a, _score: score };
  });

  return scored
    .filter(a => a._score >= 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

export const AI_RECOMMENDATIONS = [
  { id: 'rec_bundle',   label: 'Explore weekly bundle',     icon: 'Wifi',        color: 'text-violet-400', bg: 'bg-violet-400/10', path: '/bundles',   reason: 'Preview bundle signal' },
  { id: 'rec_paybill',  label: 'Review KPLC PayBill',       icon: 'CreditCard',  color: 'text-primary',    bg: 'bg-primary/10',    path: '/paybill',   reason: 'Sample payment prompt' },
  { id: 'rec_shield',   label: 'Review Scam Shield',        icon: 'Shield',      color: 'text-primary',    bg: 'bg-primary/10',    path: '/security',  reason: 'Sample alert signal' },
  { id: 'rec_budget',   label: 'Check spending insights',   icon: 'BarChart2',   color: 'text-blue-400',   bg: 'bg-blue-400/10',   path: '/budget',    reason: 'Preview budget signal' },
  ...(import.meta.env.VITE_ALLOW_INTERNAL_PAGES === 'true' ? [
    { id: 'rec_bonga', label: 'Explore Bonga Points', icon: 'Gift', color: 'text-amber-400', bg: 'bg-amber-400/10', path: '/bonga', reason: 'Rewards pilot model' },
  ] : []),
];
