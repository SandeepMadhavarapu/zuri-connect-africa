import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Wifi, Clock, CheckCircle2, Loader2 } from 'lucide-react';
import { generateTxRef } from '../lib/ledger';
import { recordLedgerDebit } from '../lib/mpesa';
import {
  initiateServerPayment,
  resumePaymentAfterStepUp,
  waitForPaymentConfirmation,
  paymentStatusMessage,
} from '@/services/paymentService.js';
import { invokeEdgeFunction } from '@/api/client.js';
import AuthGate from '@/components/security/AuthGate';
import BiometricStepUpModal from '@/components/security/BiometricStepUpModal';
import OTPEntry from '@/components/auth/OTPEntry';
import PinPad from '@/components/security/PinPad';
import { useAuth } from '@/lib/AuthContext';
import { resolveLedgerIdentityWithFallback } from '@/lib/userIdentity';
import { toast } from '@/components/ui/use-toast';
const categories = ['Daily', 'Weekly', 'Monthly', 'Social', 'Binge'];

const bundles = {
  Daily: [
    { id: 1, name: '350 MB',  price: 20,   validity: '24hrs',   tag: null },
    { id: 2, name: '1 GB',    price: 49,   validity: '24hrs',   tag: 'Popular' },
    { id: 3, name: '2.5 GB',  price: 99,   validity: '24hrs',   tag: null },
  ],
  Weekly: [
    { id: 4, name: '2 GB',    price: 149,  validity: '7 days',  tag: null },
    { id: 5, name: '5 GB',    price: 249,  validity: '7 days',  tag: 'Best Value' },
    { id: 6, name: '10 GB',   price: 399,  validity: '7 days',  tag: null },
  ],
  Monthly: [
    { id: 7,  name: '5 GB',       price: 499,  validity: '30 days', tag: null },
    { id: 8,  name: '15 GB',      price: 999,  validity: '30 days', tag: 'Best Value' },
    { id: 9,  name: '30 GB',      price: 1999, validity: '30 days', tag: null },
    { id: 10, name: 'Unlimited',  price: 3999, validity: '30 days', tag: null },
  ],
  Social: [
    { id: 11, name: 'WhatsApp 1GB',  price: 25, validity: '7 days', tag: null },
    { id: 12, name: 'TikTok 2GB',   price: 59, validity: '7 days', tag: null },
    { id: 13, name: 'All Social 3GB', price: 99, validity: '7 days', tag: 'Popular' },
  ],
  Binge: [
    { id: 14, name: 'Netflix 5GB',   price: 149, validity: '7 days', tag: null },
    { id: 15, name: 'YouTube 10GB',  price: 199, validity: '7 days', tag: null },
  ],
};

export default function Bundles() {
  const { user } = useAuth();
  const SENDER_PHONE = resolveLedgerIdentityWithFallback(user);
  const navigate    = useNavigate();
  const [activeTab, setActiveTab] = useState('Daily');
  const [selected,  setSelected]  = useState(null);
  const [done,      setDone]      = useState(false);
  const [buying,    setBuying]    = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [showAuth, setShowAuth] = useState(false);
  const [serverStepUp, setServerStepUp] = useState(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');

  const finalizeRecord = (ref) => {
    recordLedgerDebit({
      ref,
      name:   selected.name,
      phone:  '',
      amount: selected.price,
      fee:    0,
      note:   selected.validity,
      type:   'bundle',
    });
    setDone(true);
  };

  const resume = async (stepUp, proof) => {
    setPaymentStatus(paymentStatusMessage('waiting_for_mpesa'));
    const confirmed = await resumePaymentAfterStepUp(stepUp, proof, {
      onStatus: (row) => setPaymentStatus(paymentStatusMessage(row?.status)),
    });
    finalizeRecord(confirmed?.tx_ref || stepUp.tx_ref);
  };

  const handleBiometricSubmit = async (proof) => {
    if (!serverStepUp) return { ok: false };
    try {
      setBuying(true);
      await resume(serverStepUp, proof);
      setServerStepUp(null);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err?.message || 'Verification failed. Try again or use PIN.' };
    } finally {
      setBuying(false);
    }
  };

  const handleBiometricFallback = () => {
    if (!serverStepUp) return;
    setServerStepUp({ ...serverStepUp, required_step_up: 'pin' });
  };

  const handlePinSubmit = async (pin) => {
    if (!serverStepUp || !pin) return;
    try {
      setBuying(true);
      await resume(serverStepUp, { pin });
      setServerStepUp(null);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Verification failed', description: err?.message || String(err) });
    } finally {
      setBuying(false);
    }
  };

  const handleOtpSubmit = async (otpCode) => {
    if (!serverStepUp || !otpCode) return;
    try {
      setOtpLoading(true);
      setOtpError('');
      setBuying(true);
      await resume(serverStepUp, { otp: otpCode });
      setServerStepUp(null);
    } catch (err) {
      setOtpError(err?.message || 'Verification failed');
    } finally {
      setOtpLoading(false);
      setBuying(false);
    }
  };

  const handleBuy = async () => {
    if (!selected) return;
    setShowAuth(true);
  };

  const handleAuthSuccess = async () => {
    setShowAuth(false);
    if (buying || !selected) return;
    setBuying(true);
    setPaymentStatus('Starting M-PESA STK Push...');
    const ref = generateTxRef(SENDER_PHONE);

    try {
      const initiated = await initiateServerPayment({
        type:        'bundle',
        fromPhone:   SENDER_PHONE,
        toPhone:     'SAFARICOM-BUNDLES',
        amount:      selected.price,
        description: `Data Bundle: ${selected.name}`,
        txRef:       ref,
        userId:      user?.id,
        idempotencyKey: `zuri_bundle_${ref}_${user?.id || 'anon'}`,
        metadata:    { bundle_name: selected.name, validity: selected.validity },
      });

      if (initiated?.stepUpRequired) {
        setPaymentStatus(paymentStatusMessage('step_up_required'));
        const stepUp = { ...initiated, required_step_up: initiated.required_step_up || 'otp' };
        setServerStepUp(stepUp);
        if (stepUp.required_step_up === 'otp' && SENDER_PHONE) {
          try { await invokeEdgeFunction('sendOTP', { phone: SENDER_PHONE }); } catch { /* ignore */ }
        }
        return;
      }

      setPaymentStatus(paymentStatusMessage('waiting_for_mpesa'));
      const confirmed = await waitForPaymentConfirmation(initiated, {
        onStatus: (row) => setPaymentStatus(paymentStatusMessage(row?.status)),
      });
      finalizeRecord(confirmed?.tx_ref || ref);
    } catch (err) {
      const msg = err?.message || String(err);
      toast({
        variant: 'destructive',
        title: 'Bundle purchase failed',
        description: msg.includes('LEDGER_FUNDS') ? 'Insufficient M-PESA balance.' : msg,
      });
    } finally {
      setBuying(false);
      setPaymentStatus('');
    }
  };

  if (done && selected) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="flex flex-col items-center justify-center min-h-full px-4 py-20"
      >
        <div className="w-20 h-20 rounded-full gradient-green flex items-center justify-center mb-6 glow-green">
          <CheckCircle2 size={36} className="text-black" />
        </div>
        <h2 className="text-2xl font-bold text-foreground font-grotesk">Bundle Activated!</h2>
        <p className="text-muted-foreground text-sm mt-2 text-center">
          {selected.name} bundle active for {selected.validity}
        </p>
        <button onClick={() => navigate('/')} className="mt-8 gradient-green rounded-2xl px-8 py-3.5 text-black font-bold text-sm">
          Back to Home
        </button>
      </motion.div>
    );
  }

  return (
    <div className="px-4 py-4 pb-8">
      {serverStepUp && selected && serverStepUp.required_step_up === 'biometric' && (
        <BiometricStepUpModal
          open
          stepUpChallengeId={serverStepUp.step_up_challenge_id}
          actionType="payment_bundle"
          amount={Number(selected.price)}
          recipientLabel={selected.name}
          actionLabel="Authorizing bundle"
          onSubmit={handleBiometricSubmit}
          onFallbackToPin={handleBiometricFallback}
          onCancel={() => setServerStepUp(null)}
        />
      )}

      <AnimatePresence>
        {showAuth && selected && (
          <AuthGate
            type="adaptive"
            amount={Number(selected.price)}
            recipient={selected.name}
            actionType="bundle"
            onSuccess={handleAuthSuccess}
            onFailure={() => setShowAuth(false)}
            onCancel={() => setShowAuth(false)}
          />
        )}
        {serverStepUp && selected && serverStepUp.required_step_up === 'pin' && (
          <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm px-4 pb-10">
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="w-full max-w-[430px] glass rounded-3xl p-5 border border-border"
            >
              <p className="text-sm text-center text-muted-foreground mb-4">
                {paymentStatus || 'Confirm with your PIN to authorize this bundle.'}
              </p>
              <PinPad mode="verify" onSuccess={handlePinSubmit} onFailure={() => setServerStepUp(null)} />
              <button type="button" onClick={() => setServerStepUp(null)} className="w-full mt-4 text-xs text-muted-foreground py-2">
                Cancel
              </button>
            </motion.div>
          </motion.div>
        )}
        {serverStepUp && selected && serverStepUp.required_step_up === 'otp' && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm px-4 pb-10">
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="w-full max-w-[430px] glass rounded-3xl p-5 border border-border"
            >
              <p className="text-sm text-center text-muted-foreground mb-4">
                {paymentStatus || 'Enter the code we sent to your phone to authorize this bundle.'}
              </p>
              <OTPEntry
                phone={SENDER_PHONE}
                loading={otpLoading}
                error={otpError}
                onSubmit={handleOtpSubmit}
                onResend={() => invokeEdgeFunction('sendOTP', { phone: SENDER_PHONE }).catch(() => {})}
              />
              <button type="button" onClick={() => setServerStepUp(null)} className="w-full mt-4 text-xs text-muted-foreground py-2">
                Cancel
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Current usage */}
      <div className="glass-card rounded-2xl p-4 mb-5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <Wifi size={14} className="text-primary" />
            <span className="text-sm font-semibold text-foreground">Current Bundle</span>
          </div>
          <span className="text-xs text-primary font-medium">2.4 GB left</span>
        </div>
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div className="h-full rounded-full gradient-green" style={{ width: '48%' }} />
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-[10px] text-muted-foreground">2.4 GB of 5 GB used</span>
          <div className="flex items-center gap-1">
            <Clock size={10} className="text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground">4 days left</span>
          </div>
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-4 scrollbar-hide" style={{ scrollbarWidth: 'none' }}>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setActiveTab(cat)}
            className={`shrink-0 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
              activeTab === cat ? 'bg-primary text-black' : 'surface2 text-muted-foreground border border-border/50'
            }`}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Bundle grid */}
      <div className="flex flex-col gap-3">
        {(bundles[activeTab] || []).map(bundle => (
          <motion.button
            key={bundle.id}
            whileTap={{ scale: 0.98 }}
            onClick={() => setSelected(bundle)}
            className={`flex items-center gap-4 glass-card rounded-2xl px-4 py-4 w-full text-left transition-all ${
              selected?.id === bundle.id ? 'border-primary/30 glow-green-sm' : ''
            }`}
          >
            <div className="w-10 h-10 rounded-2xl flex items-center justify-center bg-primary/10">
              <Wifi size={18} className="text-primary" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-foreground">{bundle.name}</p>
                {bundle.tag && (
                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${
                    bundle.tag === 'Best Value' ? 'bg-blue-400/20 text-blue-400' :
                    'bg-muted text-muted-foreground'
                  }`}>
                    {bundle.tag}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">Valid for {bundle.validity}</p>
            </div>
            <div className="text-right">
              <p className="font-grotesk font-bold text-foreground">KSh {bundle.price}</p>
              {selected?.id === bundle.id && <CheckCircle2 size={14} className="text-primary ml-auto mt-1" />}
            </div>
          </motion.button>
        ))}
      </div>

      {selected && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-5"
        >
          <button
            disabled={buying}
            onClick={handleBuy}
            className="w-full gradient-green rounded-2xl py-4 text-black font-bold text-sm disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {buying && <Loader2 size={16} className="animate-spin" />}
            {buying ? (paymentStatus || 'Waiting for M-PESA confirmation...') : `Buy ${selected.name} - KSh ${selected.price}`}
          </button>
        </motion.div>
      )}
    </div>
  );
}
