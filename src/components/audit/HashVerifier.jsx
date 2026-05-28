import { useState } from 'react';
import { motion } from 'framer-motion';
import { ShieldCheck, ShieldAlert, Search, Copy, Check, Lock } from 'lucide-react';
import { computeHash } from '../../lib/ledger';

export default function HashVerifier({ entries, loading }) {
  const [query,    setQuery]    = useState('');
  const [copied,   setCopied]   = useState(null);

  const copy = (text, id) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  // Verify each entry's hash matches recomputed hash
  const verified = entries.map(e => {
    const expected = computeHash({
      transactionRef: e.transactionRef,
      entryType:      e.entryType,
      amount:         e.amount,
      balanceBefore:  e.balanceBefore,
      balanceAfter:   e.balanceAfter,
      accountPhone:   e.accountPhone,
    });
    const intact = e.hash === expected;
    return { ...e, expected, intact };
  });

  const filtered = query
    ? verified.filter(e =>
        e.transactionRef?.toLowerCase().includes(query.toLowerCase()) ||
        e.accountPhone?.includes(query)
      )
    : verified;

  const tampered = verified.filter(e => !e.intact);

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="glass-card rounded-2xl p-4 skeleton h-16" />
        ))}
      </div>
    );
  }

  return (
    <div>
      {/* Integrity summary banner */}
      <div
        className="flex items-center gap-3 rounded-2xl px-4 py-3 mb-4 border"
        style={tampered.length === 0
          ? { background: 'rgba(46,204,113,0.06)', borderColor: 'rgba(46,204,113,0.2)' }
          : { background: 'rgba(224,82,82,0.06)',  borderColor: 'rgba(224,82,82,0.22)' }
        }
      >
        {tampered.length === 0
          ? <ShieldCheck size={18} className="text-primary shrink-0" />
          : <ShieldAlert  size={18} className="text-red-400 shrink-0" />
        }
        <div>
          <p className={`text-[12px] font-bold ${tampered.length === 0 ? 'text-primary' : 'text-red-400'}`}>
            {tampered.length === 0
              ? `${verified.length} entries verified · No tampering detected`
              : `⚠ ${tampered.length} entries failed hash verification`
            }
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            FNV-1a integrity hash · Computed on read · Compared to stored hash
          </p>
        </div>
        <div className="ml-auto">
          <Lock size={13} className={tampered.length === 0 ? 'text-primary/50' : 'text-red-400/50'} />
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 glass-card rounded-xl px-3.5 py-2.5 mb-4 border border-white/6">
        <Search size={13} className="text-muted-foreground shrink-0" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Filter by ref or phone…"
          className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground outline-none"
        />
      </div>

      {/* Entry list */}
      {filtered.length === 0 && (
        <div className="glass-card rounded-2xl p-8 text-center">
          <p className="text-muted-foreground text-sm">No entries to verify yet.</p>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((entry, i) => (
          <motion.div
            key={entry.id}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.025, 0.3) }}
            className={`glass-card rounded-2xl px-3.5 py-3 border ${
              entry.intact ? 'border-white/5' : 'border-red-400/25'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {entry.intact
                  ? <ShieldCheck size={12} className="text-primary" />
                  : <ShieldAlert  size={12} className="text-red-400" />
                }
                <span className="text-[11px] font-grotesk font-semibold text-foreground tracking-wide">
                  {entry.transactionRef}
                </span>
              </div>
              <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border ${
                entry.entryType === 'debit'
                  ? 'text-red-400 bg-red-400/8 border-red-400/15'
                  : 'text-primary bg-primary/8 border-primary/15'
              }`}>
                {entry.entryType.toUpperCase()}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="text-[9px] text-muted-foreground/50 uppercase tracking-wider mb-0.5">Stored Hash</p>
                <div className="flex items-center gap-1.5">
                  <code className="text-[10px] font-mono text-amber-400">{entry.hash || 'missing'}</code>
                  {entry.hash && (
                    <button onClick={() => copy(entry.hash, entry.id)}>
                      {copied === entry.id
                        ? <Check size={9} className="text-primary" />
                        : <Copy size={9} className="text-muted-foreground/40" />
                      }
                    </button>
                  )}
                </div>
              </div>
              {!entry.intact && (
                <div className="text-right">
                  <p className="text-[9px] text-red-400/70 uppercase tracking-wider mb-0.5">Expected</p>
                  <code className="text-[10px] font-mono text-red-400">{entry.expected}</code>
                </div>
              )}
              {entry.intact && (
                <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-primary/6 border border-primary/12">
                  <ShieldCheck size={9} className="text-primary" />
                  <span className="text-[9px] text-primary font-semibold">Verified</span>
                </div>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}