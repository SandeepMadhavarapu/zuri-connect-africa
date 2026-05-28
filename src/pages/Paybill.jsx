import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CreditCard, Zap, Droplets, Tv, Wifi, Home, CheckCircle2, Search, Info, Flag } from 'lucide-react';
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
import {
  isVerifiedProductionEntry,
  getDirectoryDisplayCode,
  PENDING_VERIFICATION_PLACEHOLDER,
  PRODUCTION_PAYMENT_HELPER_COPY,
} from '@/lib/providerDirectory';

// NOTE: every entry below is currently treated as an unverified sample.
// The numeric `shortcode` is retained ONLY so the payment service can still
// build an initiateServerPayment request shape. The user-facing UI MUST
// render `getDirectoryDisplayCode(entry)`, never `entry.shortcode`, so users
// never see a sample number presented as if it were a verified provider
// number.
//
// IMPORTANT: server-side rejection of unverified destinations is on the
// roadmap (see AUDIT.md §24.1 — provider-search Edge Function + provider
// gate in initiate-payment). It is NOT in place today. Until that ships,
// the only thing preventing unverified-number payment is this client-side
// guard.
const popularBillers = [
  {
    id: 1, name: 'Kenya Power', shortcode: '888880', icon: Zap,
    color: 'text-yellow-400', bg: 'bg-yellow-400/10', category: 'Utilities',
    verificationStatus: 'unverified_sample', sourceRequired: true,
    lastVerifiedAt: null, reportWrongNumberEnabled: true,
    productionStatus: 'requires_provider_source',
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
  },
  {
    id: 2, name: 'Nairobi Water', shortcode: '888861', icon: Droplets,
    color: 'text-blue-400', bg: 'bg-blue-400/10', category: 'Utilities',
    verificationStatus: 'unverified_sample', sourceRequired: true,
    lastVerifiedAt: null, reportWrongNumberEnabled: true,
    productionStatus: 'requires_provider_source',
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
  },
  {
    id: 3, name: 'DSTV', shortcode: '555500', icon: Tv,
    color: 'text-purple-400', bg: 'bg-purple-400/10', category: 'Entertainment',
    verificationStatus: 'unverified_sample', sourceRequired: true,
    lastVerifiedAt: null, reportWrongNumberEnabled: true,
    productionStatus: 'requires_provider_source',
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
  },
  {
    id: 4, name: 'Safaricom Home Fibre', shortcode: '200200', icon: Wifi,
    color: 'text-primary', bg: 'bg-primary/10', category: 'Internet',
    verificationStatus: 'unverified_sample', sourceRequired: true,
    lastVerifiedAt: null, reportWrongNumberEnabled: true,
    productionStatus: 'requires_provider_source',
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
  },
  {
    id: 5, name: 'Nairobi City Rates', shortcode: '222111', icon: Home,
    color: 'text-orange-400', bg: 'bg-orange-400/10', category: 'Government',
    verificationStatus: 'unverified_sample', sourceRequired: true,
    lastVerifiedAt: null, reportWrongNumberEnabled: true,
    productionStatus: 'requires_provider_source',
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
  },
  {
    id: 6, name: 'NHIF', shortcode: '200', icon: CreditCard,
    color: 'text-red-400', bg: 'bg-red-400/10', category: 'Government',
    verificationStatus: 'unverified_sample', sourceRequired: true,
    lastVerifiedAt: null, reportWrongNumberEnabled: true,
    productionStatus: 'requires_provider_source',
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
  },
];

export default function Paybill() {
  const { user } = useAuth();
  const SENDER_PHONE = resolveLedgerIdentityWithFallback(user);
  const navigate  = useNavigate();
  const [step,      setStep]      = useState(1);
  const [selected,  setSelected]  = useState(null);
  const [accountNo, setAccountNo] = useState('');
  const [amount,    setAmount]    = useState('');
  const [search,    setSearch]    = useState('');
  const [done,      setDone]      = useState(false);
  const [paying,    setPaying]    = useState(false);
  const [showAuth,  setShowAuth]  = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [serverStepUp, setServerStepUp] = useState(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState('');

  // Search by provider name only. Searching unverified samples by their numeric
  // `shortcode` would imply those numbers are an addressable directory — they
  // are not. Verified-production entries (future) may opt-in to numeric search
  // via getDirectoryDisplayCode().
  const filtered = popularBillers.filter(b => {
    const term = search.toLowerCase();
    if (!term) return true;
    if (b.name.toLowerCase().includes(term)) return true;
    if (isVerifiedProductionEntry(b) && String(b.shortcode || '').includes(search)) return true;
    return false;
  });

  const finalizeRecord = (ref) => {
    recordLedgerDebit({
      ref,
      name:   selected.name,
      phone:  selected.shortcode,
      amount: Number(amount),
      fee:    0,
      note:   accountNo,
      type:   'paybill',
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
      setPaying(true);
      await resume(serverStepUp, proof);
      setServerStepUp(null);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err?.message || 'Verification failed. Try again or use PIN.' };
    } finally {
      setPaying(false);
    }
  };

  const handleBiometricFallback = () => {
    if (!serverStepUp) return;
    setServerStepUp({ ...serverStepUp, required_step_up: 'pin' });
  };

  const handlePinSubmit = async (pin) => {
    if (!serverStepUp || !pin) return;
    try {
      setPaying(true);
      await resume(serverStepUp, { pin });
      setServerStepUp(null);
    } catch (err) {
      toast({ variant: 'destructive', title: 'Verification failed', description: err?.message || String(err) });
    } finally {
      setPaying(false);
    }
  };

  const handleOtpSubmit = async (otpCode) => {
    if (!serverStepUp || !otpCode) return;
    try {
      setOtpLoading(true);
      setOtpError('');
      setPaying(true);
      await resume(serverStepUp, { otp: otpCode });
      setServerStepUp(null);
    } catch (err) {
      setOtpError(err?.message || 'Verification failed');
    } finally {
      setOtpLoading(false);
      setPaying(false);
    }
  };

  const handleAuthSuccess = async () => {
    setShowAuth(false);
    if (paying) return;
    setPaying(true);
    setPaymentStatus('Starting M-PESA STK Push...');
    const ref = generateTxRef(SENDER_PHONE);

    try {
      const initiated = await initiateServerPayment({
        type:        'paybill',
        fromPhone:   SENDER_PHONE,
        toPhone:     selected.shortcode,
        amount:      Number(amount),
        description: `Paybill: ${selected.name} Acc: ${accountNo}`,
        txRef:       ref,
        userId:      user?.id,
        idempotencyKey: `zuri_paybill_${ref}_${user?.id || 'anon'}`,
        metadata:    { biller_name: selected.name, account_number: accountNo },
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
        title: 'Payment failed',
        description: msg.includes('LEDGER_FUNDS') ? 'Insufficient M-PESA balance.' : msg,
      });
    } finally {
      setPaying(false);
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
        <h2 className="text-2xl font-bold text-foreground font-grotesk">Payment Sent!</h2>
        <p className="text-muted-foreground text-sm mt-2 text-center">
          KSh {Number(amount).toLocaleString()} paid to {selected.name}
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
          actionType="payment_paybill"
          amount={Number(amount)}
          recipientLabel={selected.name}
          actionLabel="Authorizing paybill"
          onSubmit={handleBiometricSubmit}
          onFallbackToPin={handleBiometricFallback}
          onCancel={() => setServerStepUp(null)}
        />
      )}

      <AnimatePresence>
        {showAuth && selected && (
          <AuthGate
            type="adaptive"
            amount={Number(amount)}
            recipient={selected.name}
            actionType="paybill"
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
                {paymentStatus || 'Confirm with your PIN to authorize this paybill.'}
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
                {paymentStatus || 'Enter the code we sent to your phone to authorize this paybill.'}
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
      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            {/* Honest directory disclaimer — every shortcode below is sample */}
            <div className="mb-3 rounded-2xl border border-amber-400/20 bg-amber-400/8 px-3.5 py-3 flex items-start gap-2.5">
              <Info size={13} className="text-amber-500 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-[12px] font-semibold text-foreground leading-tight">
                  Sample directory — verify with provider before paying.
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  Provider numbers are hidden until verified. Each entry shows
                  &ldquo;Provider number pending verification&rdquo; until a verified
                  provider source is attached.
                </p>
                <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                  {PRODUCTION_PAYMENT_HELPER_COPY}
                </p>
                <button
                  type="button"
                  onClick={() => navigate('/platform')}
                  className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-500"
                >
                  <Flag size={10} /> Report wrong number / review provider verification
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3 mb-4">
              <Search size={15} className="text-muted-foreground shrink-0" />
              <input
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                placeholder="Search billers by name..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-3">Popular Billers · sample directory</p>
            <div className="flex flex-col gap-2">
              {filtered.map(biller => {
                const Icon = biller.icon;
                return (
                  <motion.button
                    key={biller.id}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => { setSelected(biller); setStep(2); }}
                    className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3.5 w-full text-left"
                  >
                    <div className={`w-10 h-10 rounded-2xl ${biller.bg} flex items-center justify-center shrink-0`}>
                      <Icon size={18} className={biller.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground">{biller.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {getDirectoryDisplayCode(biller)} · {biller.category}
                      </p>
                    </div>
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-500 border border-amber-400/20 whitespace-nowrap">
                      Unverified sample
                    </span>
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        )}

        {step === 2 && selected && (
          <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            {(() => {
              const Icon = selected.icon;
              return (
                <>
                  <div className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3.5 mb-3">
                    <div className={`w-10 h-10 rounded-2xl ${selected.bg} flex items-center justify-center shrink-0`}>
                      <Icon size={18} className={selected.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-foreground">{selected.name}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        Paybill: {getDirectoryDisplayCode(selected)}
                      </p>
                    </div>
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-500 border border-amber-400/20 whitespace-nowrap">
                      Unverified sample
                    </span>
                  </div>
                  <div className="mb-5 rounded-xl border border-amber-400/15 bg-amber-400/6 px-3 py-2 flex items-start gap-2">
                    <Info size={11} className="text-amber-500 mt-0.5 shrink-0" />
                    <div className="flex-1">
                      <p className="text-[10px] leading-relaxed text-muted-foreground">
                        Sample directory — verify with provider before paying. The numeric
                        PayBill is hidden until a verified provider source is attached.
                      </p>
                      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
                        {PRODUCTION_PAYMENT_HELPER_COPY}
                      </p>
                      <button
                        type="button"
                        onClick={() => navigate('/platform')}
                        className="mt-1 inline-flex items-center gap-1 text-[10px] font-semibold text-amber-500"
                      >
                        <Flag size={10} /> Report wrong number / review provider verification
                      </button>
                    </div>
                  </div>
                </>
              );
            })()}

            <div className="glass-card rounded-2xl px-4 py-3.5 mb-4">
              <p className="text-[11px] text-muted-foreground mb-2">Account Number</p>
              <input
                value={accountNo}
                onChange={e => setAccountNo(e.target.value)}
                placeholder="Enter account number"
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none font-semibold"
              />
            </div>

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

            <button
              disabled={!amount || !accountNo || paying}
              onClick={() => setShowAuth(true)}
              className="w-full gradient-green rounded-2xl py-4 text-black font-bold text-sm disabled:opacity-30 flex items-center justify-center gap-2"
            >
              {paying ? (paymentStatus || 'Waiting for M-PESA confirmation...') : `Pay KSh ${amount ? Number(amount).toLocaleString() : ''} to ${selected?.name}`}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
