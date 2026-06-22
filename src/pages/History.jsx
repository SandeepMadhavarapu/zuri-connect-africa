import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowUpRight, ArrowDownLeft, Phone, Wifi, Zap,
  CreditCard, Search, TrendingDown, TrendingUp, History as HistoryIcon
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AppErrorBoundary from '@/components/AppErrorBoundary';
import { useAuth } from '@/lib/AuthContext';
import { resolveLedgerIdentityWithFallback } from '@/lib/userIdentity';
import { getWallet, getTransactions, formatDate } from '@/lib/mpesa';
import { loadMergedDisplayTransactions } from '@/lib/transactionFeed';
import { getDemoTransactionsForUi, shouldShowDemoFinancials } from '@/lib/demoMode.js';
import Eyebrow from '@/components/chama/ui/Eyebrow';

// Type accents collapsed into the Hesabu vocabulary: money-out (Sent) reads
// muted, money-in (Received) emerald, Fuliza credit brass, and the service rails
// (Airtime / Bundle / Paybill) emerald. Every icon sits in the same neutral
// surface-2 well used across the redesigned front-of-app, so the rows stay calm
// and the colour lives in the glyph + amount, not a rainbow of tinted tiles.
const typeConfig = {
  send: { icon: ArrowUpRight, color: 'text-hesabu-muted', label: 'Sent' },
  receive: { icon: ArrowDownLeft, color: 'text-hesabu-emerald', label: 'Received' },
  airtime: { icon: Phone, color: 'text-hesabu-emerald', label: 'Airtime' },
  bundle: { icon: Wifi, color: 'text-hesabu-emerald', label: 'Bundle' },
  fuliza: { icon: Zap, color: 'text-hesabu-brass', label: 'Fuliza' },
  paybill: { icon: CreditCard, color: 'text-hesabu-emerald', label: 'Paybill' },
};

const filters = ['All', 'Sent', 'Received', 'Airtime', 'Bundle', 'Paybill'];

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

export default function History() {
  const { user, isAuthenticated } = useAuth();
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState('All');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      setLoading(true);
      const w = getWallet();
      const phone = String(w.phone || resolveLedgerIdentityWithFallback(user) || '').trim();
      const base = getTransactions(100);
      const merged = await loadMergedDisplayTransactions(phone, base);
      if (cancelled) return;

      if (isAuthenticated) {
        setRows(merged.length ? merged : []);
        setLoading(false);
        return;
      }

      const allowDemo = await shouldShowDemoFinancials(false);
      const demoUi = allowDemo ? getDemoTransactionsForUi() : [];

      if (merged.length) {
        setRows(allowDemo && demoUi.length ? mergeRowsPreferReal(merged, demoUi) : merged);
        setLoading(false);
        return;
      }

      if (allowDemo && demoUi.length) {
        setRows(demoUi);
        setLoading(false);
        return;
      }

      setRows([]);
      setLoading(false);
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

  const safeTransactions = Array.isArray(rows) ? rows : [];

  const filtered = safeTransactions.filter(tx => {
    if (!tx || !tx.name || !tx.type) return false;
    const refKey = String(tx.ref || tx.id || '');
    if (!refKey) return false;
    const matchSearch = String(tx.name).toLowerCase().includes(search.toLowerCase()) || refKey.includes(search);
    const config = typeConfig[tx.type];
    const matchFilter = activeFilter === 'All' || config?.label === activeFilter;
    return matchSearch && matchFilter;
  });

  const totalIn = filtered.filter(t => t && t.amount && t.amount > 0).reduce((s, t) => s + Math.max(0, Number(t.amount) || 0), 0);
  const totalOut = filtered.filter(t => t && t.amount && t.amount < 0).reduce((s, t) => s + Math.abs(Math.max(0, Number(t.amount) || 0)), 0);

  return (
    <AppErrorBoundary>
    <div className="hesabu-theme relative">
      {/* Ink fill anchored to the scroll container so the warm green-black surface
          spans the full visible height edge-to-edge regardless of content height —
          mirrors Home.jsx / Profile.jsx. The route's
          .app-scrollbar[data-chama-route] fill handles the nav-clearance band. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-hesabu-ink"
      />

      <div className="relative px-4 py-4">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="hesabu-card hesabu-elevated rounded-2xl bg-hesabu-surface p-3.5">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={12} className="text-hesabu-emerald" />
            <Eyebrow className="text-[10px] tracking-[0.14em] text-hesabu-muted">Total In</Eyebrow>
          </div>
          <p className="font-mono tabular-nums font-bold text-lg text-hesabu-emerald">+{totalIn.toLocaleString()}</p>
        </div>
        <div className="hesabu-card hesabu-elevated rounded-2xl bg-hesabu-surface p-3.5">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown size={12} className="text-hesabu-muted" />
            <Eyebrow className="text-[10px] tracking-[0.14em] text-hesabu-muted">Total Out</Eyebrow>
          </div>
          <p className="font-mono tabular-nums font-bold text-lg text-hesabu-paper">
            {totalOut > 0 ? `-${totalOut.toLocaleString()}` : '0'}
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="hesabu-panel flex items-center gap-3 rounded-2xl px-4 py-3 mb-3">
        <Search size={15} className="text-hesabu-muted shrink-0" />
        <input
          className="flex-1 bg-transparent text-sm text-hesabu-paper placeholder:text-hesabu-muted outline-none"
          placeholder="Search transactions..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading && (
        <div className="space-y-3 mb-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-3 rounded-2xl border border-hesabu-line">
              <div className="w-10 h-10 rounded-xl bg-hesabu-surface-2 animate-pulse shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-hesabu-surface-2 rounded-full animate-pulse w-2/3" />
                <div className="h-2.5 bg-hesabu-surface-2 rounded-full animate-pulse w-1/3" />
              </div>
              <div className="h-3 bg-hesabu-surface-2 rounded-full animate-pulse w-16" />
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <>
      {/* Filters */}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-4" style={{ scrollbarWidth: 'none' }}>
        {filters.map(f => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            className={`shrink-0 px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all border ${
              activeFilter === f
                ? 'bg-hesabu-emerald/15 text-hesabu-emerald border-hesabu-emerald/30'
                : 'bg-hesabu-surface-2 text-hesabu-muted border-hesabu-line'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Transactions */}
      <div className="hesabu-card rounded-2xl overflow-hidden">
        {filtered.map((tx, i) => {
          if (!tx || !tx.type) {
            return (
              <div key={i} className="flex items-center gap-3 px-4 py-3.5 bg-hesabu-surface-2/40 animate-pulse">
                <div className="w-9 h-9 rounded-2xl bg-hesabu-surface-2 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-hesabu-surface-2 rounded w-24" />
                  <div className="h-2 bg-hesabu-surface-2 rounded w-16" />
                </div>
              </div>
            );
          }
          const config = typeConfig[tx.type];
          if (!config || !config.icon) {
            return (
              <div key={tx.id} className="flex items-center gap-3 px-4 py-3.5 text-[11px] text-hesabu-muted">
                Invalid transaction
              </div>
            );
          }
          const Icon = config.icon;
          const rawAmount = Number(tx.amount) || 0;
          const displayAmount = Math.abs(rawAmount);
          return (
            <motion.div
              key={tx.id || i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className={`flex items-center gap-3 px-4 py-3.5 transition-all active:bg-hesabu-surface-2 cursor-pointer ${
                i < filtered.length - 1 ? 'border-b border-hesabu-line' : ''
              }`}
            >
              <div className="w-9 h-9 rounded-2xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center shrink-0">
                <Icon size={16} className={config.color} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-hesabu-paper truncate">{String(tx.name || 'Transaction')}</p>
                <p className="text-[11px] text-hesabu-muted mt-0.5">{tx.date ? formatDate(tx.date) : 'Unknown date'}</p>
              </div>
              <div className="text-right shrink-0">
                <p className={`font-mono tabular-nums font-semibold text-sm ${tx.amount > 0 ? 'text-hesabu-emerald' : 'text-hesabu-paper'}`}>
                  {rawAmount > 0 ? '+' : rawAmount < 0 ? '-' : ''}KSh {displayAmount.toLocaleString()}
                </p>
                <p className="text-[10px] text-hesabu-muted">{String(tx.ref || tx.id || 'N/A')}</p>
              </div>
            </motion.div>
          );
        })}
        {filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 px-6">
            <div className="w-16 h-16 rounded-2xl bg-hesabu-surface-2 border border-hesabu-line flex items-center justify-center mb-4">
              <HistoryIcon size={24} className="text-hesabu-emerald" />
            </div>
            <p className="text-sm font-semibold text-hesabu-paper mb-1">
              No transactions yet
            </p>
            <p className="text-xs text-hesabu-muted text-center mb-6">
              Your M-PESA activity will appear here once you make your first transaction.
            </p>
            <button
              onClick={() => navigate('/wallet')}
              className="px-5 py-2.5 rounded-xl bg-hesabu-emerald/15 border border-hesabu-emerald/30 text-hesabu-emerald text-xs font-semibold transition-all hover:bg-hesabu-emerald/20"
            >
              Open Wallet
            </button>
          </div>
        )}
      </div>
        </>
      )}
      </div>
    </div>
    </AppErrorBoundary>
  );
}
