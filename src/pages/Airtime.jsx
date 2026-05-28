import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, CheckCircle2, User, Users } from 'lucide-react';
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
const quickAmounts = [10, 20, 50, 100, 200, 500, 1000];

export default function Airtime() {
  const { user } = useAuth();
  const SENDER_PHONE = resolveLedgerIdentityWithFallback(user);
  const navigate = useNavigate();
  const [tab,     setTab]     = useState('self');
  const [phone,   setPhone]   = useState('0712 345 678');
  const [amount,  setAmount]  = useState('');
  const [done,     setDone]     = useState(false);
  const [buying,   setBuying]   = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [serverStepUp, setServerStepUp] = useState(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');

  const finalizeRecord = (toPhone, ref) => {
    recordLedgerDebit({
      ref,
      name:   'Airtime Purchase',
      phone:  toPhone,
      amount: Number(amount),
      fee:    0,
      note:   '',
      type:   'airtime',
    });
    setDone(true);
  };

  const resume = async (stepUp, proof, toPhone) => {
    setPaymentStatus(paymentStatusMessage('waiting_for_mpesa'));
    const confirmed = await resumePaymentAfterStepUp(stepUp, proof, {
      onStatus: (row) => setPaymentStatus(paymentStatusMessage(row?.status)),
    });
    finalizeRecord(toPhone, confirmed?.tx_ref || stepUp.tx_ref);
  };

  const handleBiometricSubmit = async (proof) => {
    if (!serverStepUp) return { ok: false };
    try {
      setBuying(true);
      const toPhone = phone.replace(/\s/g, '');
      await resume(serverStepUp, proof, toPhone);
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
    const toPhone = phone.replace(/\s/g, '');
    try {
      setBuying(true);
      await resume(serverStepUp, { pin }, toPhone);
      setServerStepUp(null);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Verification failed', description: err?.message || String(err) });
    } finally {
      setBuying(false);
    }
  };

  const handleOtpSubmit = async (otpCode) => {
    if (!serverStepUp || !otpCode) return;
    const toPhone = phone.replace(/\s/g, '');
    try {
      setOtpLoading(true);
      setOtpError('');
      setBuying(true);
      await resume(serverStepUp, { otp: otpCode }, toPhone);
      setServerStepUp(null);
    } catch (err) {
      setOtpError(err?.message || 'Verification failed');
    } finally {
      setOtpLoading(false);
      setBuying(false);
    }
  };

  const handleAuthSuccess = async () => {
    setShowAuth(false);
    if (buying) return;
    setBuying(true);
    setPaymentStatus('Starting M-PESA STK Push...');
    const ref = generateTxRef(SENDER_PHONE);
    const toPhone = phone.replace(/\s/g, '');

    try {
      const initiated = await initiateServerPayment({
        type:        'airtime',
        fromPhone:   SENDER_PHONE,
        toPhone,
        amount:      Number(amount),
        description: `Airtime for ${phone}`,
        txRef:       ref,
        userId:      user?.id,
        idempotencyKey: `zuri_airtime_${ref}_${user?.id || 'anon'}`,
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
      finalizeRecord(toPhone, confirmed?.tx_ref || ref);
    } catch (err) {
      const msg = err?.message || String(err);
      toast({
        variant: 'destructive',
        title: 'Airtime purchase failed',
        description: msg.includes('LEDGER_FUNDS') ? 'Insufficient M-PESA balance.' : msg,
      });
    } finally {
      setBuying(false);
      setPaymentStatus('');
    }
  };

  return (
    <div className="px-4 py-4 pb-8">
      {serverStepUp && serverStepUp.required_step_up === 'biometric' && (
        <BiometricStepUpModal
          open
          stepUpChallengeId={serverStepUp.step_up_challenge_id}
          actionType="payment_airtime"
          amount={Number(amount)}
          recipientLabel={`Airtime · ${phone}`}
          actionLabel="Authorizing airtime"
          onSubmit={handleBiometricSubmit}
          onFallbackToPin={handleBiometricFallback}
          onCancel={() => setServerStepUp(null)}
        />
      )}

      <AnimatePresence>
        {showAuth && (
          <AuthGate
            type="adaptive"
            amount={Number(amount)}
            recipient={`Airtime · ${phone}`}
            actionType="airtime"
            onSuccess={handleAuthSuccess}
            onFailure={() => setShowAuth(false)}
            onCancel={() => setShowAuth(false)}
          />
        )}
        {serverStepUp && serverStepUp.required_step_up === 'pin' && (
          <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm px-4 pb-10">
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="w-full max-w-[430px] glass rounded-3xl p-5 border border-border"
            >
              <p className="text-sm text-center text-muted-foreground mb-4">
                {paymentStatus || 'Confirm with your PIN to authorize this purchase.'}
              </p>
              <PinPad mode="verify" onSuccess={handlePinSubmit} onFailure={() => setServerStepUp(null)} />
              <button type="button" onClick={() => setServerStepUp(null)} className="w-full mt-4 text-xs text-muted-foreground py-2">
                Cancel
              </button>
            </motion.div>
          </motion.div>
        )}
        {serverStepUp && serverStepUp.required_step_up === 'otp' && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm px-4 pb-10">
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="w-full max-w-[430px] glass rounded-3xl p-5 border border-border"
            >
              <p className="text-sm text-center text-muted-foreground mb-4">
                {paymentStatus || 'Enter the code we sent to your phone to authorize this purchase.'}
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
      {!done ? (
        <>
          {/* Tabs */}
          <div className="flex gap-2 mb-5">
            {[{ id: 'self', label: 'For Myself', icon: User }, { id: 'other', label: 'For Someone', icon: Users }].map(t => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  onClick={() => { setTab(t.id); setPhone(t.id === 'self' ? '0712 345 678' : ''); }}
                  className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-semibold transition-all ${
                    tab === t.id ? 'gradient-green text-black' : 'surface2 text-muted-foreground border border-border/50'
                  }`}
                >
                  <Icon size={15} />
                  {t.label}
                </button>
              );
            })}
          </div>

          {tab === 'other' && (
            <div className="glass-card rounded-2xl px-4 py-3 mb-4">
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Enter phone number"
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>
          )}

          {tab === 'self' && (
            <div className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3.5 mb-4">
              <div className="w-9 h-9 rounded-xl gradient-green flex items-center justify-center">
                <Phone size={16} className="text-black" />
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Your number</p>
                <p className="text-sm font-semibold text-foreground">{phone}</p>
              </div>
            </div>
          )}

          {/* Amount */}
          <div className="text-center mb-5">
            <p className="text-xs text-muted-foreground font-medium mb-2">Amount (KSh)</p>
            <div className="flex items-baseline justify-center gap-2">
              <span className="text-xl text-primary font-grotesk font-semibold">KSh</span>
              <input
                type="number"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0"
                className="bg-transparent text-5xl font-bold font-grotesk text-foreground outline-none text-center w-36"
              />
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 mb-5">
            {quickAmounts.map(amt => (
              <button
                key={amt}
                onClick={() => setAmount(String(amt))}
                className={`py-2.5 rounded-xl text-xs font-semibold transition-all ${
                  amount === String(amt) ? 'bg-primary text-black' : 'surface2 text-muted-foreground border border-border/50'
                }`}
              >
                {amt}
              </button>
            ))}
          </div>

          <button
            disabled={!amount || !phone || buying}
            onClick={() => setShowAuth(true)}
            className="w-full gradient-green rounded-2xl py-4 text-black font-bold text-sm disabled:opacity-30 flex items-center justify-center gap-2"
          >
            {buying ? (paymentStatus || 'Waiting for M-PESA confirmation...') : `Buy KSh ${amount ? Number(amount).toLocaleString() : ''} Airtime`}
          </button>
        </>
      ) : (
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="flex flex-col items-center justify-center py-20"
        >
          <div className="w-20 h-20 rounded-full gradient-green flex items-center justify-center mb-6 glow-green">
            <CheckCircle2 size={36} className="text-black" />
          </div>
          <h2 className="text-2xl font-bold text-foreground font-grotesk">Airtime Loaded!</h2>
          <p className="text-muted-foreground text-sm mt-2 text-center">
            KSh {Number(amount).toLocaleString()} airtime added to {phone}
          </p>
          <button onClick={() => navigate('/')} className="mt-8 gradient-green rounded-2xl px-8 py-3.5 text-black font-bold text-sm">
            Back to Home
          </button>
        </motion.div>
      )}
    </div>
  );
}
