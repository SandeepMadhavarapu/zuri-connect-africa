/**
 * Zuri Connect Africa — Adaptive Quick Actions Engine
 * Learns from usage patterns, time-of-day, and recency.
 */

import {
  CalendarClock, Wallet,
  Shield, Sparkles,
} from 'lucide-react';
import { AI_BRAND } from '@/lib/branding/aiBrand';

const STORAGE_KEY = 'zuri_quick_actions_v1';

export const CATEGORIES = ['All', 'Transact', 'Bills', 'Security', 'AI Tools'];

export const DEFAULT_QUICK_ACTIONS = [
  { id: 'wallet',    label: 'Wallet',     icon: 'Wallet',        color: 'text-primary',      bg: 'bg-primary/10',      path: '/wallet',    category: 'Transact', pinned: false, usageCount: 0, lastUsed: null },
  { id: 'schedules', label: 'Standing',   icon: 'CalendarClock', color: 'text-orange-400',   bg: 'bg-orange-400/10',   path: '/schedules', category: 'Bills',    pinned: false, usageCount: 0, lastUsed: null },
  { id: 'security',  label: 'Security',   icon: 'Shield',        color: 'text-primary',      bg: 'bg-primary/10',      path: '/security',  category: 'Security', pinned: false, usageCount: 0, lastUsed: null },
  { id: 'ai',        label: AI_BRAND.quickActionLabel, icon: 'Sparkles', color: 'text-violet-400', bg: 'bg-violet-400/10', path: '/ai', category: 'AI Tools', pinned: false, usageCount: 0, lastUsed: null },
];

// Icon map for serialization (we store icon names, not components)
export const ICON_MAP = {
  CalendarClock, Wallet, Shield, Sparkles,
};

export function getQuickActions() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_QUICK_ACTIONS.map(a => ({ ...a }));
    const saved = JSON.parse(raw);
    // Merge: add any new defaults not yet in saved; drop obsolete ids
    const validIds = new Set(DEFAULT_QUICK_ACTIONS.map(a => a.id));
    const savedIds = new Set(saved.map(a => a.id));
    const merged = saved.filter(a => validIds.has(a.id));
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

export function getRecommendedActions(allActions, limit = 3) {
  const now = Date.now();

  const scored = allActions.map(a => {
    let score = (a.usageCount || 0) * 10;
    if (a.lastUsed && now - a.lastUsed < 86_400_000) score += 20;
    if (a.lastUsed && now - a.lastUsed < 3_600_000) score += 30;
    if (a.pinned) score = -1;
    return { ...a, _score: score };
  });

  return scored
    .filter(a => a._score >= 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

export const AI_RECOMMENDATIONS = [
  { id: 'rec_shield', label: 'Review Scam Shield', icon: 'Shield', color: 'text-primary', bg: 'bg-primary/10', path: '/security', reason: 'Sample alert signal' },
];
