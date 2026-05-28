import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, BarChart2, PieChart, Info } from 'lucide-react';
import BudgetOverview from '../components/budget/BudgetOverview';
import SpendingByCategory from '../components/budget/SpendingByCategory';
import MonthlyTrendChart from '../components/budget/MonthlyTrendChart';
import AIInsightsPanel from '../components/budget/AIInsightsPanel';
import BudgetLimitModal from '../components/budget/BudgetLimitModal';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import RenderGuard from '@/components/system/RenderGuard';
import { AI_BRAND } from '@/lib/branding/aiBrand';

const TABS = [
  { key: 'overview', label: 'Overview',         icon: PieChart  },
  { key: 'trends',   label: 'Trends',           icon: BarChart2 },
  { key: 'insights', label: AI_BRAND.name,      icon: Sparkles  },
];

/*
  Tab transition: mode="sync" (NOT "wait") — avoids content-area height collapsing
  to zero during the exit animation. New tab content mounts immediately.
*/
const tabVariants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0, transition: { duration: 0.18, ease: 'easeOut' } },
  exit:    { opacity: 0, y: -6, transition: { duration: 0.12, ease: 'easeIn' } },
};

export default function Budget() {
  const [activeTab,       setActiveTab]       = useState('overview');
  const [editingCategory, setEditingCategory] = useState(null);

  return (
    <AppErrorBoundary>
      {/* Shell wrapper already provides ~96–124px bottom padding; add a small
          safety spacer at the end so the final alert card never feels visually
          flush with the bottom nav on smaller devices. */}
      <div className="px-4 py-4 pb-6"
           data-testid="budget-page-container">

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-foreground font-grotesk">Budget & Insights</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {new Date().toLocaleString('en-KE', { month: 'long', year: 'numeric' })} · Preview analysis
            </p>
          </div>
          <div className="w-9 h-9 rounded-2xl bg-primary/10 flex items-center justify-center animate-pulse-green">
            <Sparkles size={16} className="text-primary" />
          </div>
        </div>

        {/* Sample data disclaimer */}
        <div className="mb-4 rounded-2xl border border-amber-400/15 bg-amber-400/8 px-3.5 py-3 flex items-start gap-2.5">
          <Info size={13} className="text-amber-500 mt-0.5 shrink-0" />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Budget figures are sample data — will reflect your M-PESA transaction history in production.
          </p>
        </div>

        {/* Tab bar */}
        <div className="flex gap-2 mb-5 glass-card rounded-2xl p-1">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all ${
                activeTab === key ? 'bg-primary text-black' : 'text-muted-foreground'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {/* Tab content — mode="sync" prevents height collapse between tabs */}
        <AnimatePresence mode="sync" initial={false}>
          {activeTab === 'overview' && (
            <motion.div key="overview" variants={tabVariants} initial="initial" animate="animate" exit="exit">
              <RenderGuard name="Budget Overview">
                <BudgetOverview onEditCategory={setEditingCategory} />
              </RenderGuard>
              <RenderGuard name="Spending by Category">
                <SpendingByCategory onEditCategory={setEditingCategory} />
              </RenderGuard>
            </motion.div>
          )}
          {activeTab === 'trends' && (
            <motion.div key="trends" variants={tabVariants} initial="initial" animate="animate" exit="exit">
              <RenderGuard name="Monthly Trends Chart">
                <MonthlyTrendChart />
              </RenderGuard>
            </motion.div>
          )}
          {activeTab === 'insights' && (
            <motion.div key="insights" variants={tabVariants} initial="initial" animate="animate" exit="exit">
              <RenderGuard name="AI Insights">
                <AIInsightsPanel />
              </RenderGuard>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {editingCategory && (
            <BudgetLimitModal
              category={editingCategory}
              onClose={() => setEditingCategory(null)}
            />
          )}
        </AnimatePresence>

        {/* Bottom-nav safety spacer — guarantees the last alert is never clipped
            by the floating bottom nav on short viewports. */}
        <div aria-hidden="true" className="h-6" data-testid="budget-bottom-spacer" />
      </div>
    </AppErrorBoundary>
  );
}