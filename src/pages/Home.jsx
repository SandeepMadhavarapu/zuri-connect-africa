import React from 'react';
import { motion } from 'framer-motion';
import { Activity, Info, Lock, ShieldCheck, Wifi } from 'lucide-react';
import RenderGuard from '@/components/system/RenderGuard';
import BalanceCard from '../components/home/BalanceCard';
import QuickActionsGrid from '../components/home/QuickActionsGrid';
import RecentActivity from '../components/home/RecentActivity';
import EcosystemGrid from '../components/ecosystem/EcosystemGrid';
import SmartHeroCard from '../components/home/SmartHeroCard';
import AITimeline from '../components/home/AITimeline';
import DynamicWidgets from '../components/home/DynamicWidgets';
import PredictiveActions from '../components/home/PredictiveActions';

const itemVariants = {
  hidden:   { opacity: 0, y: 10 },
  visible:  { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.34, 1.56, 0.64, 1] } },
};

const containerVariants = {
  hidden:   { opacity: 1 },
  visible:  { opacity: 1, transition: { staggerChildren: 0.07, delayChildren: 0.05 } },
};

function DukeCommandCenterCard() {
  // Trust chips are intentionally non-time-bound. "Risk monitoring active" and
  // "Ledger integrity checks" are backed by real server-side telemetry (scam
  // shield + ledger hash chain). "Network status" deliberately omits the word
  // "healthy" because there is no live device-side probe yet — see
  // /network-status for the operator-published snapshot.
  const statusChips = [
    { label: 'Risk monitoring active', icon: ShieldCheck },
    { label: 'Ledger integrity checks', icon: Lock },
    { label: 'Network status', icon: Wifi },
  ];

  return (
    <div className="premium-card rounded-[24px] p-4 overflow-hidden relative">
      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-primary/10 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="security-shield-pulse flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 border border-primary/15">
          <Activity size={18} className="text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[13px] font-bold text-foreground">Duke AI wallet safeguards</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Wallet protection uses server risk checks and ledger integrity monitoring.
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-primary/10 px-2 py-1 text-[10px] font-bold text-primary border border-primary/15">
              Protected
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {statusChips.map(({ label, icon: Icon }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/80 border border-primary/10 px-2.5 py-1.5 text-[10px] font-bold text-foreground shadow-sm"
              >
                <Icon size={11} className="text-primary" />
                {label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="pb-1"
    >
      <motion.div variants={itemVariants}>
        <RenderGuard name="Balance Card">
          <BalanceCard />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4" variants={itemVariants}>
        <RenderGuard name="Duke Command Center">
          <DukeCommandCenterCard />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4" variants={itemVariants}>
        <RenderGuard name="AI Insight">
          <SmartHeroCard />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4" variants={itemVariants}>
        <RenderGuard name="Quick Actions">
          <QuickActionsGrid />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4" variants={itemVariants}>
        <RenderGuard name="Predictive Actions">
          <PredictiveActions />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4" variants={itemVariants}>
        <RenderGuard name="Recent Activity">
          <RecentActivity />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4" variants={itemVariants}>
        <RenderGuard name="Dynamic Widgets">
          <DynamicWidgets />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4" variants={itemVariants}>
        <RenderGuard name="AI Timeline">
          <AITimeline />
        </RenderGuard>
      </motion.div>

      <motion.div className="px-4 mt-4 mb-2" variants={itemVariants}>
        <div className="mb-3 rounded-2xl border border-amber-400/15 bg-amber-400/8 px-3.5 py-3 flex items-start gap-2.5">
          <Info size={13} className="text-amber-500 mt-0.5 shrink-0" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Service directory preview — PayBill/Till entries require verified provider sources before production use.
          </p>
        </div>
        <RenderGuard name="Ecosystem">
          <EcosystemGrid />
        </RenderGuard>
      </motion.div>
    </motion.div>
  );
}
