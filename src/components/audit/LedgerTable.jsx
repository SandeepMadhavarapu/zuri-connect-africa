import { useState } from 'react';
import { motion } from 'framer-motion';
import { ArrowUpRight, ArrowDownLeft, ChevronDown, ChevronUp, Copy, Check } from 'lucide-react';

export default function LedgerTable({ entries, loading }) {
  const [expanded, setExpanded] = useState(null);
  const [copied,   setCopied]   = useState(null);

  const copy = (text, id) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="glass-card rounded-2xl p-4 skeleton h-16" />
        ))}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="glass-card rounded-2xl p-8 text-center">
        <p className="text-muted-foreground text-sm">No ledger entries yet.</p>
        <p className="text-[11px] text-muted-foreground/60 mt-1">Post a transaction to begin the audit trail.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Column headers */}
      <div className="flex items-center gap-2 px-3 pb-1">
        <span className="text-[9px] text-muted-foreground/60 uppercase tracking-widest w-16">Type</span>
        <span className="text-[9px] text-muted-foreground/60 uppercase tracking-widest flex-1">Ref / Account</span>
        <span className="text-[9px] text-muted-foreground/60 uppercase tracking-widest text-right w-20">Amount</span>
      </div>

      {entries.map((entry, i) => {
        const isDebit  = entry.entryType === 'debit';
        const isOpen   = expanded === entry.id;
        const Icon     = isDebit ? ArrowUpRight : ArrowDownLeft;
        const color    = isDebit ? 'text-red-400' : 'text-primary';
        const bg       = isDebit ? 'bg-red-400/8 border-red-400/12' : 'bg-primary/8 border-primary/12';
        const label    = isDebit ? 'DR' : 'CR';

        return (
          <motion.div
            key={entry.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.03, 0.3) }}
            className="glass-card rounded-2xl overflow-hidden border border-white/5"
          >
            {/* Row */}
            <button
              onClick={() => setExpanded(isOpen ? null : entry.id)}
              className="flex items-center gap-2.5 px-3.5 py-3 w-full text-left"
            >
              {/* Type badge */}
              <div className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-[10px] font-bold font-grotesk ${bg} ${color} w-12 justify-center shrink-0`}>
                <Icon size={9} />
                {label}
              </div>

              {/* Ref + phone */}
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-grotesk font-semibold text-foreground truncate tracking-wide">
                  {entry.transactionRef}
                </p>
                <p className="text-[10px] text-muted-foreground truncate mt-0.5">{entry.accountPhone}</p>
              </div>

              {/* Amount */}
              <div className="text-right shrink-0">
                <p className={`text-[13px] font-bold font-grotesk ${color}`}>
                  {isDebit ? '-' : '+'}KSh {entry.amount?.toLocaleString()}
                </p>
                <p className="text-[9px] text-muted-foreground mt-0.5">
                  Bal: {entry.balanceAfter?.toLocaleString()}
                </p>
              </div>

              {isOpen
                ? <ChevronUp  size={12} className="text-muted-foreground shrink-0" />
                : <ChevronDown size={12} className="text-muted-foreground shrink-0" />
              }
            </button>

            {/* Expanded detail */}
            {isOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="border-t border-white/5 px-3.5 py-3 space-y-2"
                style={{ background: 'rgba(255,255,255,0.02)' }}
              >
                <DetailRow label="Balance Before" value={`KSh ${entry.balanceBefore?.toLocaleString()}`} />
                <DetailRow label="Balance After"  value={`KSh ${entry.balanceAfter?.toLocaleString()}`} />
                {entry.description && <DetailRow label="Description" value={entry.description} />}
                <DetailRow label="Date" value={new Date(entry.created_date).toLocaleString('en-KE')} />

                {/* Hash row */}
                <div className="flex items-center justify-between pt-1.5 mt-1.5 border-t border-white/5">
                  <span className="text-[9px] text-muted-foreground/60 uppercase tracking-widest">Integrity Hash</span>
                  <div className="flex items-center gap-1.5">
                    <code className="text-[10px] text-amber-400 font-mono bg-amber-400/6 px-2 py-0.5 rounded-lg border border-amber-400/15">
                      {entry.hash || '—'}
                    </code>
                    <button onClick={() => copy(entry.hash, entry.id)} className="text-muted-foreground/60 hover:text-muted-foreground">
                      {copied === entry.id ? <Check size={10} className="text-primary" /> : <Copy size={10} />}
                    </button>
                  </div>
                </div>

                {/* Immutability badge */}
                <div className="flex items-center gap-1.5 pt-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                  <span className="text-[9px] text-primary/70 font-medium">Append-only · Cannot be modified or deleted</span>
                </div>
              </motion.div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">{label}</span>
      <span className="text-[11px] text-foreground font-medium">{value}</span>
    </div>
  );
}