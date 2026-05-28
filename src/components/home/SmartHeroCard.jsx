import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/AuthContext';
import {
  Sparkles, ChevronRight, ShieldCheck, TrendingDown,
  Wifi, Zap,
} from 'lucide-react';
import { getFirstNameForGreeting } from '@/lib/formatters/userDisplay';

const HERO_INSIGHTS = [
  {
    id: 'bundle',
    icon: Wifi,
    color: 'text-amber-400',
    bg: 'bg-amber-400/10',
    border: 'border-amber-400/15',
    headline: 'Sample bundle signal',
    sub: 'Preview suggestion from sample usage data',
    cta: 'Renew now',
    path: '/bundles',
  },
  {
    id: 'spend',
    icon: TrendingDown,
    color: 'text-primary',
    bg: 'bg-primary/10',
    border: 'border-primary/15',
    headline: 'Sample spend signal',
    sub: 'Preview insight from sample airtime history',
    cta: 'See breakdown',
    path: '/budget',
  },
  {
    id: 'shield',
    icon: ShieldCheck,
    color: 'text-primary',
    bg: 'bg-primary/10',
    border: 'border-primary/15',
    headline: 'Scam Shield preview signal',
    sub: 'Sample fraud patterns prepared for review.',
    cta: 'Review',
    path: '/security',
  },
  {
    id: 'fuliza',
    icon: Zap,
    color: 'text-orange-400',
    bg: 'bg-orange-400/10',
    border: 'border-orange-400/15',
    headline: 'Fuliza readiness preview',
    sub: 'Limit display requires provider-verified eligibility.',
    cta: 'View limit',
    path: '/fuliza',
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
    <div className="premium-card rounded-[24px] p-4 overflow-hidden relative">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/35 to-transparent" />
      {/* Greeting row */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <div className="w-6 h-6 rounded-xl bg-primary/10 border border-primary/15 flex items-center justify-center">
            <Sparkles size={11} className="text-primary" />
          </div>
          <span className="section-title">Smart Insights</span>
        </div>
        <div className="flex items-center gap-1">
          {HERO_INSIGHTS.map((_, i) => (
            <button key={i} onClick={() => setIdx(i)}
              className={`w-1.5 h-1.5 rounded-full transition-all ${i === idx ? 'bg-primary w-3' : 'bg-white/20'}`} />
          ))}
        </div>
      </div>

      {/* Greeting */}
      <p className="text-[12px] font-medium text-muted-foreground mb-3">{getGreeting(user?.full_name)}</p>

      {/* Rotating insight */}
      <AnimatePresence mode="wait">
        <motion.div
          key={insight.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.25 }}
          onClick={() => navigate(insight.path)}
          className={`flex items-center gap-3 rounded-2xl px-3.5 py-3 cursor-pointer ${insight.bg} border ${insight.border} shadow-sm`}
        >
          <div className={`w-10 h-10 rounded-2xl bg-white/70 border border-white/70 flex items-center justify-center shrink-0 shadow-sm`}>
            <Icon size={15} className={insight.color} />
          </div>
          <div className="flex-1 min-w-0">
            <p className={`text-[13px] font-semibold ${insight.color} leading-tight`}>{insight.headline}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{insight.sub}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0 rounded-full bg-white/65 border border-white/70 px-2.5 py-1">
            <span className={`text-[11px] font-bold ${insight.color}`}>{insight.cta}</span>
            <ChevronRight size={12} className={insight.color} />
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
