import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Check } from 'lucide-react';
import { DEFAULT_LIMITS } from './budgetData';

export default function BudgetLimitModal({ category, onClose }) {
  const saved = (() => {
    try { return JSON.parse(localStorage.getItem('budgetLimits')) || DEFAULT_LIMITS; } catch { return DEFAULT_LIMITS; }
  })();

  const [value, setValue] = useState(String(saved[category.key] || DEFAULT_LIMITS[category.key] || 0));

  const handleSave = () => {
    const updated = { ...saved, [category.key]: Number(value) };
    localStorage.setItem('budgetLimits', JSON.stringify(updated));
    window.dispatchEvent(new Event('budgetLimitsUpdated'));
    onClose();
  };

  const pct = Math.min(100, Math.round((category.spent / Number(value || 1)) * 100));
  const over = category.spent > Number(value);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 400, damping: 40 }}
        className="relative w-full max-w-[430px] glass rounded-t-3xl px-5 pt-5 pb-10 z-10"
        style={{ borderTop: '1px solid rgba(0,200,83,0.15)' }}
      >
        <div className="w-10 h-1 rounded-full bg-muted mx-auto mb-5" />

        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2.5">
            <span className="text-2xl">{category.emoji}</span>
            <div>
              <p className="text-base font-bold text-foreground font-grotesk">{category.label}</p>
              <p className="text-xs text-muted-foreground">Set monthly budget limit</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl surface2 flex items-center justify-center">
            <X size={14} className="text-muted-foreground" />
          </button>
        </div>

        {/* Current spend vs limit preview */}
        <div className="glass-card rounded-2xl p-4 mb-5">
          <div className="flex justify-between text-xs text-muted-foreground mb-2">
            <span>Spent this month</span>
            <span className={over ? 'text-red-400 font-semibold' : 'text-foreground font-semibold'}>
              KSh {category.spent.toLocaleString()} / {Number(value).toLocaleString()}
            </span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
            <motion.div
              className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: over ? '#E53935' : pct > 75 ? '#FFB300' : category.color }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.4 }}
            />
          </div>
          {over && (
            <p className="text-[11px] text-red-400 mt-1.5 font-medium">
              Over budget by KSh {(category.spent - Number(value)).toLocaleString()}
            </p>
          )}
        </div>

        {/* Amount input */}
        <p className="text-xs text-muted-foreground font-medium mb-2">Monthly limit (KSh)</p>
        <div className="glass-card rounded-2xl px-4 py-3.5 flex items-center gap-2 mb-3" style={{ borderColor: `${category.color}40` }}>
          <span className="text-xs font-semibold text-muted-foreground">KSh</span>
          <input
            type="number"
            value={value}
            onChange={e => setValue(e.target.value)}
            className="flex-1 bg-transparent text-lg font-grotesk font-bold text-foreground outline-none"
            placeholder="0"
          />
        </div>

        {/* Quick preset buttons */}
        <div className="flex gap-2 mb-5">
          {[1000, 2000, 3000, 5000].map(v => (
            <button key={v} onClick={() => setValue(String(v))}
              className={`flex-1 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                Number(value) === v ? 'bg-primary text-black border-primary' : 'border-border/50 text-muted-foreground'
              }`}>
              {v >= 1000 ? `${v / 1000}k` : v}
            </button>
          ))}
        </div>

        <button
          onClick={handleSave}
          className="w-full gradient-green rounded-2xl py-4 flex items-center justify-center gap-2 text-black font-bold text-sm"
        >
          <Check size={17} />
          Save Budget Limit
        </button>
      </motion.div>
    </div>
  );
}