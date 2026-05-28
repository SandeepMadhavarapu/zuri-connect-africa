import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff } from 'lucide-react';
import { isLinked } from '../../lib/mpesa';
import { deriveBalance, deriveBalanceFromLocalLedgerOnly } from '../../lib/ledger';
import { useAuth } from '@/lib/AuthContext';
import { resolveLedgerIdentityWithFallback } from '@/lib/userIdentity';
import { devWarn } from '@/lib/devLog';
import {
  deriveDemoBalance,
  getDemoTransactions,
  shouldShowDemoFinancials,
} from '@/lib/demoMode.js';
import {
  formatKenyanPhone,
  getFirstNameForGreeting,
} from '@/lib/formatters/userDisplay';

export default function BalanceCard() {
  const { user, isAuthenticated } = useAuth();
  const SENDER_PHONE = resolveLedgerIdentityWithFallback(user);
  const [visible, setVisible] = useState(true);
  const [mpesa, setMpesa] = useState(null);
  const [loadErr, setLoadErr] = useState(false);
  const [balanceAnimated, setBalanceAnimated] = useState(false);
  const [showSampleFinancials, setShowSampleFinancials] = useState(false);

  const loadBalance = async () => {
    if (!SENDER_PHONE) {
      setMpesa(0);
      setLoadErr(false);
      setShowSampleFinancials(false);
      return;
    }
    const allowDemo = await shouldShowDemoFinancials(isAuthenticated);
    if (!isAuthenticated && allowDemo) {
      setShowSampleFinancials(true);
      const bal = deriveDemoBalance(getDemoTransactions());
      setMpesa(bal);
      setLoadErr(false);
      if (!balanceAnimated) setBalanceAnimated(true);
      return;
    }
    setShowSampleFinancials(false);
    try {
      const localSnap = deriveBalanceFromLocalLedgerOnly(SENDER_PHONE);
      setMpesa(localSnap);
      setLoadErr(false);
      if (!balanceAnimated) setBalanceAnimated(true);
      const b = await deriveBalance(SENDER_PHONE);
      setMpesa(b ?? 0);
    } catch (err) {
      devWarn('Balance load failed:', err);
      setMpesa(deriveBalanceFromLocalLedgerOnly(SENDER_PHONE));
      setLoadErr(true);
    }
  };

  useEffect(() => {
    loadBalance();
    const handler = () => loadBalance();
    const demoHandler = () => loadBalance();
    window.addEventListener('mpesa_updated', handler);
    window.addEventListener('zuri_demo_updated', demoHandler);
    return () => {
      window.removeEventListener('mpesa_updated', handler);
      window.removeEventListener('zuri_demo_updated', demoHandler);
    };
  }, [SENDER_PHONE, isAuthenticated]);

  const appEnv = import.meta.env.VITE_APP_ENV;
  const allowPitchSampleFinancials =
    (appEnv === 'local' || appEnv === 'demo') &&
    import.meta.env.VITE_ALLOW_CLIENT_DEMO_CONTROLS === 'true' &&
    import.meta.env.VITE_STRICT_ENV !== 'true';
  const usePitchSampleFinancials = showSampleFinancials && allowPitchSampleFinancials;
  const displayMpesa = usePitchSampleFinancials ? '24,850' : mpesa !== null ? mpesa.toLocaleString() : '------';
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <motion.div
      className="relative overflow-hidden px-4 pt-5 pb-4"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.6 }}
    >
      <motion.div
        className="flex items-center justify-between mb-3"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        <div className="min-w-0">
          <p className="section-title mb-1">
            {greeting}, {getFirstNameForGreeting(user?.full_name || user?.email)}
          </p>
          <p className="text-foreground text-[15px] font-grotesk font-bold tracking-tight truncate">
            {user?.phone ? formatKenyanPhone(user.phone) : 'M-PESA wallet'}
          </p>
        </div>
        <motion.div
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/8 border border-primary/15 shadow-sm"
          whileHover={{ scale: 1.05 }}
        >
          <motion.div
            className="w-1.5 h-1.5 rounded-full bg-primary"
            animate={{ opacity: [1, 0.5, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <span className="text-xs text-primary font-bold">
            {showSampleFinancials ? 'Sample data' : 'Protected'}
          </span>
        </motion.div>
      </motion.div>

      <motion.div
        className="rounded-[28px] p-5 relative overflow-hidden premium-card-strong text-white"
        initial={{ opacity: 0, y: 16, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.7, delay: 0.15, ease: [0.34, 1.56, 0.64, 1] }}
      >
        <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(255,255,255,0.18),transparent_42%,rgba(0,0,0,0.08))]" />

        <div className="relative z-10">
          <motion.button
            onClick={() => setVisible(!visible)}
            className="absolute top-0 right-0 w-9 h-9 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center hover:bg-white/20 transition-all"
            whileHover={{ scale: 1.08 }}
            whileTap={{ scale: 0.9 }}
          >
            <motion.div
              key={visible ? 'shown' : 'hidden'}
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.8, opacity: 0 }}
            >
              {visible ? (
                <Eye size={16} className="text-white/80" />
              ) : (
                <EyeOff size={16} className="text-white/80" />
              )}
            </motion.div>
          </motion.button>

          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/70 mb-3">Available Balance</p>
          </motion.div>

          <motion.div
            className="flex items-baseline gap-2.5 mb-5 pr-10"
            key={visible ? 'shown' : 'hidden'}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4 }}
          >
            <span className="text-sm font-semibold text-white/70 font-grotesk">KSh</span>
            {mpesa === null && !loadErr ? (
              <div className="w-32 h-12 bg-white/20 rounded-xl animate-pulse" />
            ) : (
              <motion.span
                className="text-5xl font-bold font-grotesk text-white leading-none tracking-tight drop-shadow-sm"
                initial={balanceAnimated ? { scale: 0.8, opacity: 0 } : {}}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ duration: 0.8, ease: [0.34, 1.56, 0.64, 1] }}
              >
                {visible ? displayMpesa : '******'}
              </motion.span>
            )}
          </motion.div>

          <motion.div
            className="flex items-center gap-2 pb-4 border-b border-white/15"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.3 }}
          >
            <motion.div
              className="w-2 h-2 rounded-full bg-white"
              animate={{ scale: [1, 1.3, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            <span className="text-xs font-semibold text-white/80">
              {showSampleFinancials
                ? 'Sample balances - not live funds'
                : isLinked()
                  ? 'Verified session'
                  : 'Wallet protected'}
            </span>
          </motion.div>

          <motion.div
            className="grid grid-cols-3 gap-2.5 pt-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            <SubBalance
              label="Fuliza"
              value={visible ? (usePitchSampleFinancials ? 'Available' : '--') : '--'}
              color="text-amber-100"
              hint={usePitchSampleFinancials ? 'Ready if needed' : 'No overdraft active'}
            />
            <SubBalance
              label="Savings"
              value={visible ? (usePitchSampleFinancials ? 'KSh 8,200' : '--') : '--'}
              color="text-white"
              hint={usePitchSampleFinancials ? 'Wallet ready' : 'Link M-PESA'}
            />
            <SubBalance
              label="Rewards"
              value={visible ? (usePitchSampleFinancials ? '1,240' : '0') : '--'}
              color="text-white"
              hint="Earn on sends"
            />
          </motion.div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function SubBalance({ label, value, color, hint }) {
  return (
    <motion.div
      className="rounded-2xl bg-white/10 border border-white/15 px-2 py-2.5 text-center"
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.2 }}
    >
      <p className="text-[9px] font-bold uppercase tracking-[0.12em] text-white/60 mb-1.5">{label}</p>
      <p className={`font-grotesk font-bold text-base ${color}`}>{value}</p>
      {hint && value === '--' && (
        <p className="text-[9px] text-white/60 mt-0.5 leading-tight">{hint}</p>
      )}
    </motion.div>
  );
}
