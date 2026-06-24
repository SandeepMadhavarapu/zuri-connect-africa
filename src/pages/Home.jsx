import React from 'react';
import { motion } from 'framer-motion';
import { Activity, Lock, ShieldCheck, Wifi } from 'lucide-react';
import RenderGuard from '@/components/system/RenderGuard';
import BalanceCard from '../components/home/BalanceCard';
import QuickActionsGrid from '../components/home/QuickActionsGrid';
import RecentActivity from '../components/home/RecentActivity';
// EcosystemGrid (the "Explore Services" PayBill directory) is intentionally not
// rendered on the Hesabu surface — it's Zuri super-app surface that doesn't fit
// the chama-treasury product. Component/data files are kept in the repo for now.
// import EcosystemGrid from '../components/ecosystem/EcosystemGrid';
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
    <div className="hesabu-card rounded-[24px] p-4 overflow-hidden relative">
      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-hesabu-emerald/10 blur-2xl" />
      <div className="relative flex items-start gap-3">
        <div className="security-shield-pulse flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-hesabu-surface-2 border border-hesabu-line">
          <Activity size={18} className="text-hesabu-emerald" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-[13px] font-bold text-hesabu-paper">Duke AI wallet safeguards</p>
              <p className="mt-1 text-[11px] leading-relaxed text-hesabu-muted">
                Wallet protection uses server risk checks and ledger integrity monitoring.
              </p>
            </div>
            <span className="shrink-0 rounded-full bg-hesabu-surface-2 px-2 py-1 text-[10px] font-bold text-hesabu-emerald border border-hesabu-line">
              Protected
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {statusChips.map(({ label, icon: Icon }) => (
              <span
                key={label}
                className="inline-flex items-center gap-1.5 rounded-full bg-hesabu-surface-2 border border-hesabu-line px-2.5 py-1.5 text-[10px] font-bold text-hesabu-paper"
              >
                <Icon size={11} className="text-hesabu-emerald" />
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
    <div className="hesabu-theme relative">
      {/* Ink fill anchored to the scroll container (<main>, the nearest
          positioned ancestor) so the warm green-black surface spans the full
          visible height edge-to-edge regardless of content height — mirrors the
          chama page (Chama.jsx). The route's .app-scrollbar[data-chama-route]
          fill handles the nav-clearance band beyond the content. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-hesabu-ink"
      />

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="relative pb-1"
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

      <motion.div className="px-4 mt-4 mb-2" variants={itemVariants}>
        <RenderGuard name="AI Timeline">
          <AITimeline />
        </RenderGuard>
      </motion.div>

      {/* "Explore Services" ecosystem directory (EcosystemGrid) intentionally
          removed from the Hesabu surface — see import note above. The
          accompanying "Service directory preview" caption was removed with it so
          no empty/dead section remains. */}
      </motion.div>
    </div>
  );
}
