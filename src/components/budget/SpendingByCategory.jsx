import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ChevronRight, AlertTriangle } from 'lucide-react';
import { CATEGORIES, DEFAULT_LIMITS, getCategorySpend } from './budgetData';

export default function SpendingByCategory({ onEditCategory }) {
  const [limits, setLimits] = useState(() => {
    try {
      const stored = localStorage.getItem('budgetLimits');
      if (!stored) return DEFAULT_LIMITS;
      const parsed = JSON.parse(stored);
      return parsed && typeof parsed === 'object' ? parsed : DEFAULT_LIMITS;
    } catch (e) {
      console.warn('[SpendingByCategory] localStorage read failed:', e);
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
        console.warn('[SpendingByCategory] Event handler error:', e);
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
      console.warn('[SpendingByCategory] getCategorySpend error:', e);
      return {};
    }
  })();

  const safeCategories = Array.isArray(CATEGORIES) ? CATEGORIES : [];

  const sorted = safeCategories
    .filter(c => c && typeof c === 'object' && c.key && (Number(spend?.[c.key]) || 0) > 0)
    .sort((a, b) => {
      const aSpend = Number(spend?.[a?.key]) || 0;
      const bSpend = Number(spend?.[b?.key]) || 0;
      return bSpend - aSpend;
    });

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">By Category</p>
        <p className="text-[10px] text-primary">Tap to set limits</p>
      </div>

      <div className="premium-card rounded-2xl overflow-hidden">
        {sorted.length === 0 && (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">No spending data yet this month</p>
          </div>
        )}
        {sorted.map((cat, i) => {
             if (!cat || !cat.key) {
               return (
                 <div key={`empty-${i}`} className="glass-card rounded-2xl p-4">
                   <p className="text-sm text-muted-foreground">Unable to load category</p>
                 </div>
               );
             }
             const s = Math.max(0, Number(spend?.[cat.key]) || 0);
           const limit = Math.max(0, Number(limits?.[cat.key]) || 0);
           const pct = limit > 0 ? Math.min(100, Math.round((s / limit) * 100)) : 0;
           const over = s > limit && limit > 0;
           const warn = !over && pct >= 75;

          return (
            <motion.button
              key={cat.key}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05 }}
              whileTap={{ scale: 0.99 }}
              onClick={() => onEditCategory({ ...cat, spent: s, limit })}
              className={`w-full flex items-center gap-3 px-4 py-3.5 transition-all active:bg-primary/5 hover:bg-primary/5 ${
                i < sorted.length - 1 ? 'border-b border-border/40' : ''
              }`}
            >
              {/* Emoji icon */}
              <div className="w-9 h-9 rounded-2xl flex items-center justify-center shrink-0 text-lg shadow-sm border border-white/70"
                style={{ background: `${cat.color}18` }}>
                {cat.emoji}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-foreground">{cat.label}</span>
                    {over && <AlertTriangle size={11} className="text-red-400" />}
                    {warn && <AlertTriangle size={11} className="text-yellow-400" />}
                  </div>
                  <span className={`font-grotesk font-semibold text-xs ${over ? 'text-red-400' : 'text-foreground'}`}>
                    KSh {s.toLocaleString()}
                    <span className="text-muted-foreground font-normal"> / {limit.toLocaleString()}</span>
                  </span>
                </div>
                {/* Progress bar */}
                <div className="h-1.5 rounded-full overflow-hidden bg-border/70">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ background: over ? '#E53935' : warn ? '#FFB300' : cat.color }}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.8, ease: 'easeOut', delay: i * 0.05 }}
                  />
                </div>
              </div>

              <ChevronRight size={14} className="text-muted-foreground shrink-0 ml-1" />
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
