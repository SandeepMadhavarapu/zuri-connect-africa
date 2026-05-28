import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Zap, CheckCircle2, Info, Loader2 } from 'lucide-react';
import { generateTxRef } from '../lib/ledger';
import { recordLedgerCredit } from '../lib/mpesa';
import { initiateAndWaitForPayment } from '@/services/paymentService.js';
import { useAuth } from '@/lib/AuthContext';
import { resolveLedgerIdentityWithFallback } from '@/lib/userIdentity';
import { toast } from '@/components/ui/use-toast';

export default function Fuliza() {
  const { user } = useAuth();
  const SENDER_PHONE = resolveLedgerIdentityWithFallback(user);
  const navigate = useNavigate();
  const [amount,     setAmount]    = useState('');
  const [done,       setDone]      = useState(false);
  const [activating, setActivating] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');

  const limit     = 5000;
  const used      = 0;
  const available = limit - used;
  const dailyFee  = Math.ceil((Number(amount) || 0) * 0.01);

  const handleActivate = async () => {
    if (activating) return;
    setActivating(true);
    setPaymentStatus('Starting M-PESA confirmation...');
    const ref = generateTxRef(SENDER_PHONE);

    try {
      await initiateAndWaitForPayment({
        type:        'fuliza_drawdown',
        fromPhone:   SENDER_PHONE,
        toPhone:     'FULIZA-ENGINE',
        amount:      Number(amount),
        description: 'Fuliza drawdown',
        txRef:       ref,
        userId:      user?.id,
        idempotencyKey: `zuri_fuliza_${ref}_${user?.id || 'anon'}`,
      }, {
        onStatus: (row) => {
          if (row?.status === 'processing') setPaymentStatus('Waiting for M-PESA confirmation...');
          else if (row?.status) setPaymentStatus(`Payment ${row.status}`);
        },
      });

      recordLedgerCredit({
        ref,
        fromName:  'Fuliza M-PESA',
        fromPhone: 'FULIZA-ENGINE',
        amount:    Number(amount),
        note:      'Fuliza drawdown',
        type:      'fuliza',
      });

      setDone(true);
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Fuliza request failed',
        description: err?.message || String(err),
      });
    } finally {
      setActivating(false);
      setPaymentStatus('');
    }
  };

  if (done) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex flex-col items-center justify-center min-h-full px-4 py-20"
      >
        <div className="w-20 h-20 rounded-full bg-yellow-400/20 border border-yellow-400/30 flex items-center justify-center mb-6">
          <CheckCircle2 size={36} className="text-yellow-400" />
        </div>
        <h2 className="text-2xl font-bold text-foreground font-grotesk">Fuliza Active!</h2>
        <p className="text-muted-foreground text-sm mt-2 text-center">
          KSh {Number(amount).toLocaleString()} added to your M-PESA
        </p>
        <div className="glass-card rounded-2xl p-4 mt-6 w-full text-left">
          <p className="text-xs text-muted-foreground mb-3 font-semibold">FULIZA TERMS</p>
          <InfoRow label="Daily fee" value={`KSh ${dailyFee}/day`} />
          <InfoRow label="Repay by" value="Next deposit" />
          <InfoRow label="Auto-repay" value="Enabled" color="text-primary" />
        </div>
        <button onClick={() => navigate('/')} className="mt-6 gradient-green rounded-2xl px-8 py-3.5 text-black font-bold text-sm">
          Back to Home
        </button>
      </motion.div>
    );
  }

  return (
    <div className="px-4 py-4 pb-8">
      {/* Fuliza status */}
      <div className="relative overflow-hidden glass-card rounded-3xl p-5 mb-5" style={{ borderColor: 'rgba(255,179,0,0.2)' }}>
        <div className="absolute top-0 right-0 w-32 h-32 rounded-full bg-yellow-400/5 blur-2xl" />
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-xl bg-yellow-400/15 flex items-center justify-center">
            <Zap size={16} className="text-yellow-400" />
          </div>
          <span className="font-semibold text-foreground text-sm">Fuliza M-PESA</span>
          <span className="ml-auto text-[10px] font-bold px-2 py-0.5 rounded-full bg-yellow-400/15 text-yellow-400">ACTIVE</span>
        </div>
        <p className="text-xs text-muted-foreground mb-1">Available Limit</p>
        <p className="font-grotesk text-4xl font-bold text-foreground">KSh {available.toLocaleString()}</p>
        <div className="h-1.5 bg-muted rounded-full mt-3 overflow-hidden">
          <div className="h-full bg-yellow-400 rounded-full" style={{ width: `${(available / limit) * 100}%` }} />
        </div>
        <p className="text-[11px] text-muted-foreground mt-1">KSh {used.toLocaleString()} used of KSh {limit.toLocaleString()} limit</p>
      </div>

      {/* How it works */}
      <div className="flex items-start gap-3 glass-card rounded-2xl px-4 py-3.5 mb-5">
        <Info size={14} className="text-blue-400 shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          Fuliza lets you complete M-PESA transactions even when you don't have enough balance. You are charged a daily maintenance fee until you repay.
        </p>
      </div>

      {/* Amount input */}
      <div className="text-center mb-6">
        <p className="text-xs text-muted-foreground font-medium mb-2">How much do you need? (KSh)</p>
        <div className="flex items-baseline justify-center gap-2">
          <span className="text-xl text-yellow-400 font-grotesk font-semibold">KSh</span>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0"
            max={available}
            className="bg-transparent text-5xl font-bold font-grotesk text-foreground outline-none text-center w-36"
          />
        </div>
      </div>

      {/* Fee preview */}
      {amount && Number(amount) > 0 && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card rounded-2xl p-4 mb-5">
          <p className="text-xs text-muted-foreground font-semibold mb-3">COST PREVIEW</p>
          <InfoRow label="Amount" value={`KSh ${Number(amount).toLocaleString()}`} />
          <InfoRow label="Daily fee (1%)" value={`KSh ${dailyFee}/day`} />
          <InfoRow label="Auto-repay" value="On next deposit" color="text-primary" />
        </motion.div>
      )}

      <button
        disabled={!amount || Number(amount) <= 0 || Number(amount) > available || activating}
        onClick={handleActivate}
        className="w-full rounded-2xl py-4 text-black font-bold text-sm disabled:opacity-30 transition-all flex items-center justify-center gap-2"
        style={{ background: Number(amount) > 0 && !activating ? '#FFB300' : undefined }}
      >
        {activating && <Loader2 size={16} className="animate-spin" />}
        {activating ? (paymentStatus || 'Waiting for M-PESA confirmation...') : `Activate Fuliza for KSh ${amount ? Number(amount).toLocaleString() : ''}`}
      </button>
    </div>
  );
}

function InfoRow({ label, value, color }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold ${color || 'text-foreground'}`}>{value}</span>
    </div>
  );
}
