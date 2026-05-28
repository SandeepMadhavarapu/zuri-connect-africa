import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertTriangle } from 'lucide-react';
import { CATEGORIES, DEFAULT_LIMITS, getCategorySpend } from './budgetData';

export default function BudgetOverview({ onEditCategory }) {
  const [limits, setLimits] = useState(() => {
    try {
      const stored = localStorage.getItem('budgetLimits');
      if (!stored) return DEFAULT_LIMITS;
      const parsed = JSON.parse(stored);
      return parsed && typeof parsed === 'object' ? parsed : DEFAULT_LIMITS;
    } catch (e) {
      console.warn('[BudgetOverview] localStorage read failed:', e);
      return DEFAULT_LIMITS;
    }
  });

  useEffect(() => {
    const handler = () => {
      try {
        const stored = localStorage.getItem('budgetLimits');
        if (!stored) {
          setLimits(DEFAULT_LIMITS);
          return;
        }
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') {
          setLimits(parsed);
        }
      } catch (e) {
        console.warn('[BudgetOverview] Event handler error:', e);
      }
    };
    window.addEventListener('budgetLimitsUpdated', handler);
    return () => window.removeEventListener('budgetLimitsUpdated', handler);
  }, []);

  const spend = (() => {
    try {
      const result = getCategorySpend?.();
      return (result && typeof result === 'object') ? result : {};
    } catch (e) {
      console.warn('[BudgetOverview] getCategorySpend error:', e);
      return {};
    }
  })();

  const spendValues = Object.values(spend).map(v => {
    const num = Number(v);
    return !isNaN(num) ? Math.max(0, num) : 0;
  });
  const totalSpend = spendValues.reduce((s, v) => s + v, 0) || 0;

  const limitValues = Object.values(limits || {}).map(v => {
    const num = Number(v);
    return !isNaN(num) ? Math.max(0, num) : 0;
  });
  const totalBudget = limitValues.reduce((s, v) => s + v, 0) || 1;

  const safeCategories = Array.isArray(CATEGORIES) ? CATEGORIES : [];
  const overCount = safeCategories.filter(c => {
    if (!c || !c.key) return false;
    const s = Math.max(0, Number(spend?.[c.key]) || 0);
    const l = Math.max(0, Number(limits?.[c.key]) || 0);
    return l > 0 && s > l;
  }).length;
  const attentionCount = safeCategories.filter(c => {
    if (!c || !c.key) return false;
    const s = Math.max(0, Number(spend?.[c.key]) || 0);
    const l = Math.max(0, Number(limits?.[c.key]) || 0);
    if (l <= 0) return false;
    return s > l || Math.round((s / l) * 100) >= 75;
  }).length;

  const pct = totalBudget > 0 ? Math.min(100, Math.round((Math.max(0, totalSpend) / Math.max(1, totalBudget)) * 100)) : 0;

  return (
    <div className="mb-4">
      {totalSpend > 0 && (
        <div className="premium-card rounded-[24px] p-4 mb-4 overflow-hidden relative">
          <div className="absolute -right-8 -top-10 h-24 w-24 rounded-full bg-primary/10 blur-2xl" />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <p className="section-title mb-1">Budget health</p>
              <p className="font-grotesk text-xl font-bold text-foreground">
                {attentionCount} categor{attentionCount === 1 ? 'y needs' : 'ies need'} attention
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">Based on current month spend and limits</p>
            </div>
            <div className="shrink-0 rounded-2xl bg-primary/10 border border-primary/15 px-3 py-2 text-right">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary">Tracked</p>
              <p className="font-grotesk text-sm font-bold text-foreground">KSh {totalSpend.toLocaleString()}</p>
            </div>
          </div>
        </div>
      )}

      {/* Total Budget Ring */}
      <div className="premium-card rounded-3xl p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <p className="text-xs text-muted-foreground font-medium">Total Spent (May)</p>
            <p className="font-grotesk font-bold text-3xl text-foreground mt-0.5">
              KSh {(totalSpend || 0).toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              of KSh {(totalBudget || 0).toLocaleString()} budget
            </p>
          </div>
          <div className="relative w-20 h-20">
            <svg className="w-full h-full -rotate-90" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" fill="none" stroke="hsl(var(--border))" strokeWidth="7" />
              <motion.circle
                cx="32" cy="32" r="26" fill="none"
                stroke={pct > 85 ? '#E53935' : pct > 65 ? '#FFB300' : '#00C853'}
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={`${2 * Math.PI * 26}`}
                initial={{ strokeDashoffset: 2 * Math.PI * 26 }}
                animate={{ strokeDashoffset: 2 * Math.PI * 26 * (1 - pct / 100) }}
                transition={{ duration: 1, ease: 'easeOut' }}
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="font-grotesk font-bold text-base text-foreground">{pct}%</span>
            </div>
          </div>
        </div>

        {/* Warning banner */}
        {overCount > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            className="flex items-center gap-2.5 bg-red-400/8 border border-red-400/20 rounded-xl px-3 py-2.5 mt-2"
          >
            <AlertTriangle size={13} className="text-red-400 shrink-0" />
            <p className="text-xs text-red-400 font-medium">
              {overCount} categor{overCount > 1 ? 'ies have' : 'y has'} exceeded budget limits this month
            </p>
          </motion.div>
        )}
      </div>
    </div>
  );
}
