import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  ShieldAlert, WifiOff, X, Sparkles,
} from 'lucide-react';

const ACTIONS = [
  {
    id: 'freeze',
    icon: ShieldAlert,
    color: 'text-red-400',
    bg: 'bg-red-400/10',
    border: 'border-red-400/20',
    label: 'Review security signal?',
    reason: 'Sample risk pattern for Scam Shield review',
    cta: 'Review',
    path: '/security',
    priority: 1,
  },
  {
    id: 'wifi',
    icon: WifiOff,
    color: 'text-muted-foreground',
    bg: 'bg-white/5',
    border: 'border-white/10',
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
            <Sparkles size={11} className="text-violet-400" />
            <p className="section-title">Suggested Actions</p>
          </div>

          <div className="flex flex-col gap-2">
            <AnimatePresence>
              {visible.map((action, i) => {
            const Icon = action.icon;
            return (
              <motion.div
                key={action.id}
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.22 }}
                className={`premium-card rounded-2xl px-3.5 py-3 ${action.border} flex items-center gap-3`}
              >
                <div className={`w-8 h-8 rounded-xl ${action.bg} border border-primary/10 flex items-center justify-center shrink-0`}>
                  <Icon size={14} className={action.color} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-semibold text-foreground leading-tight">{action.label}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">{action.reason}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => action.path ? navigate(action.path) : setDismissed(d => [...d, action.id])}
                    className={`text-[11px] font-semibold px-2.5 py-1 rounded-xl border ${action.bg} ${action.color} ${action.border}`}
                  >
                    {action.cta}
                  </button>
                  <button
                    onClick={() => setDismissed(d => [...d, action.id])}
                    className="w-6 h-6 rounded-lg bg-white/5 flex items-center justify-center"
                  >
                    <X size={10} className="text-muted-foreground" />
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
