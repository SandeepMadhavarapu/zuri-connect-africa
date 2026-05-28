import { motion } from 'framer-motion';
import { CheckCircle2, AlertTriangle, Clock, Hash } from 'lucide-react';

const STATUS_CONFIG = {
  balanced:    { icon: CheckCircle2,  color: 'text-primary',   bg: 'bg-primary/8',   border: 'border-primary/20',   label: 'Balanced' },
  discrepancy: { icon: AlertTriangle, color: 'text-red-400',   bg: 'bg-red-400/8',   border: 'border-red-400/20',   label: 'Discrepancy' },
  pending:     { icon: Clock,         color: 'text-amber-400', bg: 'bg-amber-400/8', border: 'border-amber-400/20', label: 'Pending' },
  error:       { icon: AlertTriangle, color: 'text-red-400',   bg: 'bg-red-400/8',   border: 'border-red-400/20',   label: 'Error' },
};

export default function ReconciliationPanel({ logs, loading }) {
  if (loading) {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="glass-card rounded-2xl p-4 skeleton h-24" />
        ))}
      </div>
    );
  }

  if (!Array.isArray(logs) || logs.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <Hash size={24} className="text-muted-foreground/30 mx-auto mb-3" />
        <p className="text-muted-foreground text-sm font-medium">No reconciliation runs yet</p>
        <p className="text-[11px] text-muted-foreground/60 mt-1">Run a reconciliation from the dashboard header.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Legend */}
      <div className="flex items-center gap-3 px-1 pb-1">
        {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
          <div key={key} className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${cfg.color.replace('text-', 'bg-')}`} />
            <span className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">{cfg.label}</span>
          </div>
        ))}
      </div>

      {Array.isArray(logs) && logs.map((log, i) => {
        if (!log || typeof log !== 'object') return null;
        const cfg = STATUS_CONFIG[log?.status] || STATUS_CONFIG.pending;
        const Icon = cfg.icon;
        const balanced = log.status === 'balanced';

        return (
          <motion.div
            key={log.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            className={`glass-card rounded-2xl p-4 border ${cfg.border}`}
          >
            {/* Header row */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className={`w-6 h-6 rounded-lg ${cfg.bg} flex items-center justify-center`}>
                  <Icon size={12} className={cfg.color} />
                </div>
                <div>
                  <p className={`text-[12px] font-bold font-grotesk ${cfg.color}`}>{cfg.label}</p>
                  <p className="text-[10px] text-muted-foreground">{log.runDate}</p>
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground/60 font-grotesk">
                {log.entriesChecked} entries checked
              </span>
            </div>

            {/* Debit / Credit bars */}
             <div className="space-y-2 mb-3">
               {(() => {
                 const debits = Math.max(0, Number(log?.totalDebits) || 0);
                 const credits = Math.max(0, Number(log?.totalCredits) || 0);
                 const maxVal = Math.max(debits, credits, 1);
                 const debitPct = !isNaN(debits) ? (debits / maxVal) * 100 : 0;
                 const creditPct = !isNaN(credits) ? (credits / maxVal) * 100 : 0;
                 return (
                   <>
                     <BarRow label="Total Debits"  amount={debits}  color="bg-red-400" pct={debitPct} />
                     <BarRow label="Total Credits" amount={credits} color="bg-primary"  pct={creditPct} />
                   </>
                 );
               })()}
             </div>

            {/* Difference */}
            {!balanced && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-400/6 border border-red-400/15">
                <AlertTriangle size={11} className="text-red-400 shrink-0" />
                <p className="text-[11px] text-red-400 font-semibold">
                  Difference: KSh {log.difference?.toLocaleString()} — Manual review required
                </p>
              </div>
            )}
            {balanced && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-primary/6 border border-primary/15">
                <CheckCircle2 size={11} className="text-primary shrink-0" />
                <p className="text-[11px] text-primary font-semibold">All double-entry pairs verified · Difference: KSh 0</p>
              </div>
            )}

            {/* Timestamp */}
            <p className="text-[9px] text-muted-foreground/40 mt-2.5 text-right font-mono">
              {new Date(log.created_date).toLocaleString('en-KE')}
            </p>
          </motion.div>
        );
      })}
    </div>
  );
}

function BarRow({ label, amount, color, pct }) {
   const safeAmount = Math.max(0, Number(amount) || 0);
   const safePct = (() => {
     const p = Number(pct);
     return typeof p === 'number' && !isNaN(p) ? Math.max(0, Math.min(100, p)) : 0;
   })();

   return (
     <div>
       <div className="flex items-center justify-between mb-1">
         <span className="text-[9px] text-muted-foreground/60 uppercase tracking-wider">{label}</span>
         <span className="text-[10px] font-grotesk font-semibold text-foreground">KSh {safeAmount.toLocaleString()}</span>
       </div>
       <div className="h-1 rounded-full bg-white/5 overflow-hidden">
         <motion.div
           initial={{ width: 0 }}
           animate={{ width: `${safePct}%` }}
           transition={{ duration: 0.6, ease: 'easeOut' }}
           className={`h-full rounded-full ${color}`}
         />
       </div>
     </div>
   );
 }