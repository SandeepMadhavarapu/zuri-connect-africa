import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import {
  Sparkles, ChevronRight, ShieldCheck, Wallet,
  CalendarClock,
} from 'lucide-react';
import { getFirstNameForGreeting } from '@/lib/formatters/userDisplay';

// Accent styling is now uniform (emerald) in the Hesabu redesign, so the per-item
// color/bg/border fields were dropped — the icon + CTA read emerald everywhere.
const HERO_INSIGHTS = [
  {
    id: 'wallet',
    icon: Wallet,
    headline: 'Chama treasury wallet',
    sub: 'View group savings balance and recent contributions.',
    cta: 'Open wallet',
    path: '/wallet',
  },
  {
    id: 'shield',
    icon: ShieldCheck,
    headline: 'Scam Shield preview signal',
    sub: 'Sample fraud patterns prepared for review.',
    cta: 'Review',
    path: '/security',
  },
  {
    id: 'schedules',
    icon: CalendarClock,
    headline: 'Standing orders',
    sub: 'Manage recurring contributions and scheduled payments.',
    cta: 'View orders',
    path: '/schedules',
  },
];

function getGreeting(name) {
  const h = new Date().getHours();
  const first = getFirstNameForGreeting(name);
  if (h < 12) return `Good morning, ${first}`;
  if (h < 17) return `Good afternoon, ${first}`;
  return `Good evening, ${first}`;
}

export default function SmartHeroCard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [idx, setIdx] = useState(0);

  // Rotate insight every 6 seconds
  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % HERO_INSIGHTS.length), 6000);
    return () => clearInterval(t);
  }, []);

  const insight = HERO_INSIGHTS[idx];
  const Icon = insight.icon;

  return (
    <div className="hesabu-card rounded-[24px] p-4 overflow-hidden relative">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-hesabu-emerald/40 to-transparent" />
      {/* Greeting row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center">
            <Sparkles size={11} className="text-hesabu-emerald" />
          </div>
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-paper/75">Smart Insights</span>
        </div>
        <div className="flex items-center gap-1">
          {HERO_INSIGHTS.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)}
              className={`h-1.5 rounded-full transition-all ${i === idx ? 'bg-hesabu-emerald w-3' : 'bg-hesabu-line w-1.5'}`} />
          ))}
        </div>
      </div>

      {/* Greeting */}
      <p className="text-[12px] font-medium text-hesabu-muted mb-3">{getGreeting(user?.full_name)}</p>

      {/* Rotating insight */}
      <AnimatePresence mode="wait">
        <motion.div
          key={insight.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25 }}
          onClick={() => navigate(insight.path)}
          className="flex items-center gap-3 rounded-2xl px-3.5 py-3 cursor-pointer bg-hesabu-surface-2 border border-hesabu-line"
        >
          <div className="w-10 h-10 rounded-2xl bg-hesabu-ink border border-hesabu-line flex items-center justify-center shrink-0">
            <Icon size={15} className="text-hesabu-emerald" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-hesabu-paper leading-tight">{insight.headline}</p>
            <p className="text-[11px] text-hesabu-muted mt-0.5 leading-relaxed">{insight.sub}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0 rounded-full bg-hesabu-ink border border-hesabu-line px-2.5 py-1">
            <span className="text-[11px] font-bold text-hesabu-emerald">{insight.cta}</span>
            <ChevronRight size={12} className="text-hesabu-emerald" />
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
