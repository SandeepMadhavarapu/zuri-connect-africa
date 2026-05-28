import { useState, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

const SYSTEMS = [
  { id: 'auth', label: 'Auth', check: () => {
    try {
      const hasSession = Object.keys(localStorage).some(
        k => k.includes('-auth-token') || k.startsWith('sb-')
      );
      return hasSession ? 'healthy' : 'degraded';
    } catch { return 'failed'; }
  }},
  { id: 'storage', label: 'Storage', check: () => {
    try {
      sessionStorage.setItem('_test', '1');
      sessionStorage.removeItem('_test');
      return 'healthy';
    } catch { return 'failed'; }
  }},
  { id: 'network', label: 'Network', check: () => navigator.onLine ? 'healthy' : 'degraded' },
  { id: 'ledger', label: 'Ledger', check: () => {
    try {
      const has =
        !!localStorage.getItem('zuri_local_ledger_v1') || !!localStorage.getItem('ledger_entries');
      return has ? 'healthy' : 'degraded';
    } catch { return 'failed'; }
  }},
];

const STATUS_COLORS = {
  healthy: 'bg-primary text-black',
  degraded: 'bg-amber-400 text-black',
  failed: 'bg-destructive text-white',
};

export default function DiagnosticsBadge() {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState({});

  useEffect(() => {
    const check = () => {
      const newStatuses = {};
      SYSTEMS.forEach(sys => {
        newStatuses[sys.id] = sys.check?.();
      });
      setStatuses(newStatuses);
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  if (import.meta.env.MODE !== 'development') return null;

  const healthStatus = Object.values(statuses).some(s => s === 'failed') ? 'failed' : 
                       Object.values(statuses).some(s => s === 'degraded') ? 'degraded' : 'healthy';

  return (
    <div className="fixed bottom-20 right-4 z-40">
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="absolute bottom-full right-0 mb-2 glass-card rounded-xl p-2 w-48 border border-white/10"
          >
            <p className="text-[9px] font-semibold text-muted-foreground uppercase mb-2 px-2">System Health</p>
            <div className="space-y-1">
              {SYSTEMS.map(sys => (
                <div key={sys.id} className="flex items-center justify-between px-2 py-1">
                  <span className="text-[10px] text-foreground">{sys.label}</span>
                  <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${STATUS_COLORS[statuses[sys.id]] || 'bg-white/10'}`}>
                    {statuses[sys.id] || 'checking'}
                  </span>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <button
        onClick={() => setOpen(!open)}
        className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${STATUS_COLORS[healthStatus] || 'bg-white/10'}`}
      >
        <ChevronDown size={16} />
      </button>
    </div>
  );
}