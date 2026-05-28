import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, ArrowDownLeft, Phone, Wifi, Zap } from 'lucide-react';
import { getWallet, getTransactions, formatDate } from '../../lib/mpesa';
import { useAuth } from '@/lib/AuthContext';
import { resolveLedgerIdentityWithFallback } from '@/lib/userIdentity';
import { loadMergedDisplayTransactions } from '@/lib/transactionFeed';
import { getDemoTransactionsForUi, shouldShowDemoFinancials } from '@/lib/demoMode.js';

const typeConfig = {
  send:    { icon: ArrowUpRight,  color: 'text-red-400',    bg: 'bg-red-400/8' },
  receive: { icon: ArrowDownLeft, color: 'text-primary',    bg: 'bg-primary/8' },
  airtime: { icon: Phone,         color: 'text-amber-400',  bg: 'bg-amber-400/8' },
  bundle:  { icon: Wifi,          color: 'text-violet-400', bg: 'bg-violet-400/8' },
  fuliza:  { icon: Zap,           color: 'text-orange-400', bg: 'bg-orange-400/8' },
  paybill: { icon: ArrowUpRight,  color: 'text-blue-400',   bg: 'bg-blue-400/8' },
};

function mergeRowsPreferReal(merged, demoUi) {
  const refs = new Set(
    (merged || []).map((t) => String(t.ref || t.id || '')).filter(Boolean)
  );
  const out = [...(merged || [])];
  for (const d of demoUi || []) {
    const r = String(d.ref || d.id || '');
    if (r && !refs.has(r)) {
      refs.add(r);
      out.push(d);
    }
  }
  return out.sort((a, b) => (Date.parse(String(b.date || '')) || 0) - (Date.parse(String(a.date || '')) || 0));
}

export default function RecentActivity() {
  const navigate = useNavigate();
  const { user, isAuthenticated } = useAuth();
  const [txs, setTxs] = useState(() =>
    Array.isArray(getTransactions(5)) ? getTransactions(5) : []
  );

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      const w = getWallet();
      const phone = String(w.phone || resolveLedgerIdentityWithFallback(user) || '').trim();
      const base = getTransactions(20);
      const merged = await loadMergedDisplayTransactions(phone, base);
      if (cancelled) return;

      if (isAuthenticated) {
        const next = merged.length ? merged.slice(0, 5) : [];
        setTxs(next);
        return;
      }

      const allowDemo = await shouldShowDemoFinancials(false);
      const demoUi = allowDemo ? getDemoTransactionsForUi() : [];

      if (merged.length) {
        const combined = allowDemo && demoUi.length ? mergeRowsPreferReal(merged, demoUi) : merged;
        setTxs(combined.slice(0, 5));
        return;
      }

      if (allowDemo && demoUi.length) {
        setTxs(demoUi.slice(0, 5));
        return;
      }

      setTxs(base.slice(0, 5));
    };
    hydrate();
    const onMpesa = () => { hydrate(); };
    const onDemo = () => { hydrate(); };
    window.addEventListener('mpesa_updated', onMpesa);
    window.addEventListener('zuri_demo_updated', onDemo);
    return () => {
      cancelled = true;
      window.removeEventListener('mpesa_updated', onMpesa);
      window.removeEventListener('zuri_demo_updated', onDemo);
    };
  }, [user, isAuthenticated]);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="section-title">Recent Transactions</p>
        <button onClick={() => navigate('/history')} className="flex items-center gap-1 text-primary text-xs font-bold bg-primary/8 border border-primary/12 rounded-full px-2.5 py-1">
          All <ArrowRight size={11} />
        </button>
      </div>

      <div className="premium-card rounded-2xl overflow-hidden">
        {txs.length === 0 && (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">No recent transactions</p>
          </div>
        )}
        {txs.map((tx, i) => {
          if (!tx || !tx.type) {
            return (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5 bg-white/3 animate-pulse">
                <div className="w-9 h-9 rounded-xl bg-white/10 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-white/10 rounded w-24" />
                  <div className="h-2 bg-white/10 rounded w-16" />
                </div>
              </div>
            );
          }
          const config = typeConfig[tx.type] || typeConfig.send;
          if (!config) {
            return (
              <div key={tx.id} className="flex items-center gap-3 px-4 py-3.5 bg-white/3">
                <div className="text-[11px] text-muted-foreground">Invalid transaction</div>
              </div>
            );
          }
          const Icon = config.icon;
          return (
            <div key={tx.id}
              className={`flex items-center gap-3 px-4 py-3.5 active:bg-primary/5 transition-all ${i < txs.length - 1 ? 'border-b border-border/60' : ''}`}
            >
              <div className={`w-9 h-9 rounded-xl ${config.bg} border border-primary/10 flex items-center justify-center shrink-0`}>
                <Icon size={15} className={config.color} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-foreground truncate">{tx.name}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{formatDate(tx.date)}</p>
              </div>
              <div className="text-right shrink-0">
                <p className={`font-grotesk font-semibold text-[13px] ${tx.amount > 0 ? 'text-primary' : 'text-foreground'}`}>
                  {tx.amount > 0 ? '+' : ''}KSh {Math.abs(tx.amount).toLocaleString()}
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{tx.id}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
