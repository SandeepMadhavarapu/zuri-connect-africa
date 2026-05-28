import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Link2, RefreshCw, FileText, Send, Unlink, Info } from 'lucide-react';
import { getWallet, isLinked, unlinkWallet } from '../lib/mpesa';
import { deriveBalance, deriveBalanceFromLocalLedgerOnly } from '../lib/ledger';
import { loadMergedDisplayTransactions } from '@/lib/transactionFeed';
import LinkWalletModal from '../components/wallet/LinkWalletModal';
import WalletStatement from '../components/wallet/WalletStatement';
import WalletTransfer from '../components/wallet/WalletTransfer';
import { LEGACY_DEMO_LEDGER_KEY } from '@/lib/userIdentity';
import { toast } from '@/components/ui/use-toast';

const TABS = [
  { key: 'statement', label: 'Statement', icon: FileText },
  { key: 'transfer',  label: 'Transfer',  icon: Send },
];

// Static sub-balances (not ledger-derived in this model)
const STATIC_SUB = { fuliza: 5000, savings: 12340, bonga: 1240 };

export default function Wallet() {
  const [linked,     setLinked]     = useState(isLinked());
  const [wallet,     setWallet]     = useState(getWallet());
  const [showLink,   setShowLink]   = useState(false);
  const [activeTab,  setActiveTab]  = useState('statement');
  const [refreshing, setRefreshing] = useState(false);
  const [mpesaBal,   setMpesaBal]   = useState(null); // ledger-derived
  const [stmtRows,   setStmtRows]   = useState([]);

  const loadBalance = async (phone) => {
    if (!phone) return;
    setMpesaBal(deriveBalanceFromLocalLedgerOnly(phone));
    const b = await deriveBalance(phone);
    setMpesaBal(b);
  };

  useEffect(() => {
    const w = getWallet();
    setWallet(w);
    setStmtRows(w.transactions || []);
    loadBalance(w.phone || LEGACY_DEMO_LEDGER_KEY);

    const handler = () => {
      const updated = getWallet();
      setWallet(updated);
      setStmtRows(updated.transactions || []);
      setLinked(isLinked());
      loadBalance(updated.phone || LEGACY_DEMO_LEDGER_KEY);
    };
    window.addEventListener('mpesa_updated', handler);
    return () => window.removeEventListener('mpesa_updated', handler);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const hydrateStmt = async () => {
      const w = getWallet();
      const phone = String(w.phone || LEGACY_DEMO_LEDGER_KEY);
      const base = w.transactions || [];
      const merged = await loadMergedDisplayTransactions(phone, base);
      if (cancelled) return;
      setStmtRows(merged.length ? merged : base);
    };
    hydrateStmt();
    const onMpesa = () => { hydrateStmt(); };
    window.addEventListener('mpesa_updated', onMpesa);
    return () => {
      cancelled = true;
      window.removeEventListener('mpesa_updated', onMpesa);
    };
  }, [linked, wallet.phone]);

  const refresh = () => {
    setRefreshing(true);
    const w = getWallet();
    setWallet(w);
    setStmtRows(w.transactions || []);
    loadBalance(w.phone || LEGACY_DEMO_LEDGER_KEY).then(() => setRefreshing(false));
  };

  const handleLinked = () => {
    setLinked(true);
    const w = getWallet();
    setWallet(w);
    setStmtRows(w.transactions || []);
    loadBalance(w.phone);
    setShowLink(false);
  };
  // Unlink only clears the *local preview* wallet metadata (this build does not
  // actually link a Safaricom account). Real provider unlinking would call a
  // backend revoke endpoint before clearing local state.
  const handleUnlink = () => {
    unlinkWallet();
    setLinked(false);
    setWallet(getWallet());
    setMpesaBal(null);
    toast({
      title: 'Preview wallet cleared',
      description: 'Local preview metadata removed from this device. No Safaricom account was affected.',
    });
  };

  if (!linked) {
    return (
      <div className="px-4 py-6 flex flex-col items-center min-h-full">
        <div className="w-20 h-20 rounded-3xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5 mt-8 animate-pulse-green">
          <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/1/15/M-PESA_LOGO-01.svg/1200px-M-PESA_LOGO-01.svg.png"
            className="w-12 h-12 object-contain" alt="M-Pesa" />
        </div>
        <h1 className="text-xl font-bold text-foreground font-grotesk mb-2">Link M-Pesa Wallet</h1>
        <p className="text-sm text-muted-foreground text-center leading-relaxed max-w-xs mb-8">
          Explore a local wallet preview for balance, statements, and secure payment flows before Safaricom Daraja onboarding is connected.
        </p>

        <div className="w-full space-y-3 mb-8">
          {[
            { icon: '💰', title: 'Preview Balance',    desc: 'See local M-Pesa, Fuliza & Savings-style balances' },
            { icon: '📄', title: 'Preview Statements', desc: 'Review local transaction history in the statement view' },
            { icon: '⚡', title: 'Secure Payment Flow', desc: 'Start payments through server-side authorization paths' },
          ].map(f => (
            <div key={f.title} className="glass-card rounded-2xl px-4 py-3.5 flex items-center gap-3">
              <span className="text-2xl">{f.icon}</span>
              <div>
                <p className="text-sm font-semibold text-foreground">{f.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>

        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => setShowLink(true)}
          className="w-full gradient-green rounded-2xl py-4 flex items-center justify-center gap-2 text-black font-bold text-base"
        >
          <Link2 size={18} /> Link M-Pesa Account
        </motion.button>

        <AnimatePresence>
          {showLink && <LinkWalletModal onClose={() => setShowLink(false)} onLinked={handleLinked} />}
        </AnimatePresence>
      </div>
    );
  }

  const displayBal = mpesaBal !== null ? mpesaBal.toLocaleString() : '—';

  return (
    <div className="px-4 py-4 pb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-primary/10 flex items-center justify-center">
            <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/1/15/M-PESA_LOGO-01.svg/1200px-M-PESA_LOGO-01.svg.png"
              className="w-5 h-5 object-contain" alt="M-Pesa" />
          </div>
          <div>
            <p className="text-sm font-bold text-foreground">M-Pesa Wallet</p>
            <p className="text-[11px] text-primary">{wallet.phone} · Linked on this device</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={refresh}
            className="w-8 h-8 rounded-xl surface2 flex items-center justify-center">
            <RefreshCw size={14} className={`text-muted-foreground ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={handleUnlink}
            className="w-8 h-8 rounded-xl bg-red-400/10 flex items-center justify-center">
            <Unlink size={13} className="text-red-400" />
          </button>
        </div>
      </div>

      {/* Single subtle disclaimer — payments still flow through the
          server-authoritative payment service; only the balance read and
          statement pull are preview-only until Daraja onboarding lands. */}
      <div
        className="glass-card rounded-xl px-3 py-2 mb-3 flex items-start gap-2"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Wallet preview — balance reads from the local ledger; live M-Pesa balance needs Safaricom Daraja onboarding.
          Payments still execute server-side.
        </p>
      </div>

      {/* Balance Cards */}
      <div className="glass-card rounded-3xl p-4 mb-4 glow-green-sm">
        <p className="text-xs text-muted-foreground mb-1">M-Pesa Balance</p>
        <p className="font-grotesk font-bold text-3xl text-foreground">
          KSh {displayBal}
        </p>
        <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-border/40">
          <SubBal label="Fuliza"  value={STATIC_SUB.fuliza}  color="text-yellow-400" />
          <SubBal label="Savings" value={STATIC_SUB.savings} color="text-blue-400" />
          <SubBal label="Bonga"   value={STATIC_SUB.bonga}   color="text-primary" />
        </div>
      </div>

      {/* Quick action pills */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <button onClick={() => setActiveTab('transfer')}
          className="glass-card rounded-2xl py-3 flex items-center justify-center gap-2 text-sm font-semibold text-foreground border-green-glow">
          <Send size={15} className="text-primary" /> Send Money
        </button>
        <button onClick={() => setActiveTab('statement')}
          className="glass-card rounded-2xl py-3 flex items-center justify-center gap-2 text-sm font-semibold text-foreground">
          <FileText size={15} className="text-blue-400" /> Statement
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 mb-4 glass-card rounded-2xl p-1">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setActiveTab(key)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeTab === key ? 'bg-primary text-black' : 'text-muted-foreground'
            }`}>
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        {activeTab === 'statement' && (
          <motion.div key="stmt" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <WalletStatement transactions={stmtRows.length ? stmtRows : wallet.transactions} />
          </motion.div>
        )}
        {activeTab === 'transfer' && (
          <motion.div key="xfer" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <WalletTransfer balance={mpesaBal || 0} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SubBal({ label, value, color }) {
  return (
    <div className="text-center">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`font-grotesk font-semibold text-sm mt-0.5 ${color}`}>{value.toLocaleString()}</p>
    </div>
  );
}
