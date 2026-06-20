import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  ShieldAlert, WifiOff, X, Sparkles,
} from 'lucide-react';

// Accent is derived from `priority` in the Hesabu redesign (danger for the risk
// signal, neutral otherwise), so the per-item color/bg/border fields were dropped.
const ACTIONS = [
  {
    id: 'freeze',
    icon: ShieldAlert,
    label: 'Review security signal?',
    reason: 'Sample risk pattern for Scam Shield review',
    cta: 'Review',
    path: '/security',
    priority: 1,
  },
  {
    id: 'wifi',
    icon: WifiOff,
    label: 'Review network status?',
    reason: 'Preview suggestion from sample network signals',
    cta: 'Dismiss',
    path: null,
    priority: 2,
  },
];

export default function PredictiveActions() {
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState([]);

  const visible = ACTIONS.filter(a => !dismissed.includes(a.id));

  return (
    <div>
      {visible.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 mb-3">
            <Sparkles size={11} className="text-hesabu-emerald" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-paper/75">Suggested Actions</p>
          </div>

          <div className="flex flex-col gap-2">
            <AnimatePresence>
              {visible.map((action) => {
            const Icon = action.icon;
            // Collapse the alert palette into the Hesabu vocabulary: a genuine
            // risk signal reads danger; everything else stays neutral.
            const isAlert = action.priority === 1;
            const accent = isAlert ? 'text-hesabu-danger' : 'text-hesabu-muted';
            return (
              <motion.div
                key={action.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.22 }}
                className={`hesabu-card rounded-2xl px-3.5 py-3 flex items-center gap-3 ${isAlert ? 'border-hesabu-danger' : ''}`}
              >
                <div className="w-8 h-8 rounded-xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center shrink-0">
                  <Icon size={14} className={accent} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-hesabu-paper leading-tight">{action.label}</p>
                  <p className="text-[10px] text-hesabu-muted mt-0.5 leading-relaxed">{action.reason}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => action.path ? navigate(action.path) : setDismissed(d => [...d, action.id])}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-xl border bg-hesabu-surface-2 ${isAlert ? 'border-hesabu-danger text-hesabu-danger' : 'border-hesabu-line text-hesabu-emerald'}`}
                  >
                    {action.cta}
                  </button>
                  <button
                    onClick={() => setDismissed(d => [...d, action.id])}
                    className="w-6 h-6 rounded-lg bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center"
                  >
                    <X size={10} className="text-hesabu-muted" />
                  </button>
                </div>
              </motion.div>
            );
              })}
            </AnimatePresence>
          </div>
        </>
      )}
    </div>
  );
}
