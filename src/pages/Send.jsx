import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, Phone, Users, ChevronRight, CheckCircle2, ArrowLeft } from 'lucide-react';
import { generateTxRef } from '../lib/ledger';
import { recordLedgerDebit } from '../lib/mpesa';
import {
  completeServerStepUp,
  initiateServerPayment,
  waitForPaymentConfirmation,
  paymentStatusMessage,
} from '@/services/paymentService.js';
import { invokeEdgeFunction } from '@/api/client.js';
import OTPEntry from '@/components/auth/OTPEntry';
import PinPad from '@/components/security/PinPad';
import BiometricStepUpModal from '@/components/security/BiometricStepUpModal';
import AuthGate from '@/components/security/AuthGate';
import { audit } from '@/lib/auditLogger';
import { useAuth } from '@/lib/AuthContext';
import { resolveLedgerIdentityWithFallback } from '@/lib/userIdentity';
import { toast } from '@/components/ui/use-toast';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

const CONTACT_COLORS = [
  'bg-primary/20 text-primary',
  'bg-blue-500/20 text-blue-400',
  'bg-purple-500/20 text-purple-400',
  'bg-amber-500/20 text-amber-400',
  'bg-green-500/20 text-green-400',
  'bg-rose-500/20 text-rose-400',
];

function getContactColor(index) {
  return CONTACT_COLORS[index % CONTACT_COLORS.length];
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

export default function Send() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const SENDER_PHONE = resolveLedgerIdentityWithFallback(user);
  const [step,          setStep]          = useState(1);
  const [recipient,     setRecipient]     = useState(null);
  const [phone,         setPhone]         = useState('');
  const [amount,        setAmount]        = useState('');
  const [note,          setNote]          = useState('');
  const [search,        setSearch]        = useState('');
  const [done,          setDone]          = useState(false);
  const [sending,       setSending]       = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');
  const [showAuth,      setShowAuth]      = useState(false);
  const [serverStepUp,  setServerStepUp]  = useState(null);
  const [otpLoading,    setOtpLoading]    = useState(false);
  const [otpError,      setOtpError]      = useState('');

  const [RECENT_CONTACTS,  setRECENT_CONTACTS]  = useState([]);
  const [contactsLoading,  setContactsLoading]  = useState(true);

  // Biometric step-up is driven by BiometricStepUpModal once serverStepUp
  // becomes available. We no longer call authenticateBiometric directly here
  // because that consumes the WebAuthn challenge before complete-step-up can
  // verify the action binding — the assertion now travels intact to the
  // server.

  useEffect(() => {
    let cancelled = false;
    async function loadContacts() {
      setContactsLoading(true);
      try {
        const supabase = getSupabaseBrowserClient();
        const { data, error } = await supabase
          .from('profiles')
          .select('display_name, phone')
          .not('phone', 'is', null)
          .neq('phone', SENDER_PHONE ?? '')
          .order('display_name', { ascending: true })
          .limit(50);

        if (error || !data || cancelled) return;

        const mapped = data.map((row, i) => ({
          name:     row.display_name || row.phone,
          phone:    row.phone,
          initials: getInitials(row.display_name || row.phone),
          color:    getContactColor(i),
        }));

        if (!cancelled) setRECENT_CONTACTS(mapped);
      } catch {
        // Non-fatal — keep empty list
      } finally {
        if (!cancelled) setContactsLoading(false);
      }
    }
    loadContacts();
    return () => { cancelled = true; };
  }, [SENDER_PHONE]);

  const filtered = RECENT_CONTACTS.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search)
  );

  const selectContact = (contact) => {
    setRecipient(contact);
    setPhone(contact.phone);
    setStep(2);
  };

  const useManualPhone = () => {
    if (!phone || phone.length < 9) return;
    setRecipient({ name: phone, phone, initials: '?', color: 'bg-muted text-muted-foreground' });
    setStep(2);
  };

  // Server-side risk evaluation runs inside initiate-payment before STK Push.
  const handleSendTap = () => {
    if (!amount || !recipient) return;
    setShowAuth(true);
  };

  const handleAuthSuccess = async () => {
    setShowAuth(false);
    executeTransaction();
  };

  const finishSuccessfulPayment = async (paymentRow) => {
    const ref = paymentRow?.tx_ref || generateTxRef(SENDER_PHONE);
    recordLedgerDebit({
        ref,
        name:   recipient.name,
        phone:  recipient.phone,
        amount: Number(amount),
        fee:    0,
        note,
        type:   'send',
      });

      try {
        audit.paymentInitiated(user?.email || 'anonymous', ref, {
          channel: 'send',
          amount: Number(amount),
        });
      } catch {
        /* non-fatal */
      }

    setDone(true);
  };

  const resumeAfterServerStepUp = async (stepUp, proof) => {
    setPaymentStatus('Verifying…');
    const resumed = await completeServerStepUp({
      pendingPaymentId: stepUp.pending_payment_id,
      stepUpChallengeId: stepUp.step_up_challenge_id,
      proof,
    });
    setServerStepUp(null);
    setPaymentStatus(paymentStatusMessage('waiting_for_mpesa'));
    const confirmed = await waitForPaymentConfirmation(resumed, {
      onStatus: (row) => setPaymentStatus(paymentStatusMessage(row?.status)),
    });
    await finishSuccessfulPayment(confirmed);
  };

  const handleServerStepUpPinSuccess = async (pin) => {
    if (!pin) return;
    try {
      setSending(true);
      await resumeAfterServerStepUp(serverStepUp, { pin });
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Verification failed',
        description: err?.message || String(err),
      });
    } finally {
      setSending(false);
      setServerStepUp(null);
    }
  };

  const handleServerStepUpOtp = async (otpCode) => {
    if (!serverStepUp) return;
    try {
      setOtpLoading(true);
      setOtpError('');
      setSending(true);
      await resumeAfterServerStepUp(serverStepUp, { otp: otpCode });
    } catch (err) {
      setOtpError(err?.message || 'Verification failed');
    } finally {
      setOtpLoading(false);
      setSending(false);
    }
  };

  const handleBiometricStepUpSubmit = async (proof) => {
    // Called by BiometricStepUpModal once navigator.credentials.get returns.
    // The proof is forwarded UNMODIFIED to completeServerStepUp where the
    // server re-checks the binding + signature. We never claim success here.
    if (!serverStepUp) return { ok: false };
    try {
      setSending(true);
      await resumeAfterServerStepUp(serverStepUp, proof);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err?.message || 'Verification failed. Try again or use PIN.' };
    } finally {
      setSending(false);
    }
  };

  const handleBiometricFallbackToPin = () => {
    if (!serverStepUp) return;
    // Switch the active step-up modal from biometric to PIN. The server still
    // enforces a fresh challenge for whichever proof type the user provides.
    setServerStepUp({ ...serverStepUp, required_step_up: 'pin' });
  };

  const handleBiometricCancel = () => {
    setServerStepUp(null);
    toast({
      title: 'Authorization cancelled',
      description: 'No payment was sent.',
    });
  };

  const executeTransaction = async () => {
    if (sending) return;
    setSending(true);
    setPaymentStatus('Starting M-PESA STK Push...');
    const ref = generateTxRef(SENDER_PHONE);
    const idempotencyKey = `zuri_send_${ref}_${user?.id || 'anon'}`;

    try {
      const initiated = await initiateServerPayment({
        type:        'send',
        fromPhone:   SENDER_PHONE,
        toPhone:     recipient.phone,
        amount:      Number(amount),
        description: note || `Send to ${recipient.name}`,
        txRef:       ref,
        userId:      user?.id,
        idempotencyKey,
        metadata:    { recipient_name: recipient.name },
      });

      if (initiated?.stepUpRequired) {
        setPaymentStatus(paymentStatusMessage('step_up_required'));
        const stepUp = {
          ...initiated,
          required_step_up: initiated.required_step_up || 'otp',
        };
        setServerStepUp(stepUp);
        if (stepUp.required_step_up === 'otp' && SENDER_PHONE) {
          try {
            await invokeEdgeFunction('sendOTP', { phone: SENDER_PHONE });
          } catch {
            /* resend available from OTP UI */
          }
        }
        return;
      }

      setPaymentStatus(paymentStatusMessage('waiting_for_mpesa'));
      const confirmed = await waitForPaymentConfirmation(initiated, {
        onStatus: (row) => setPaymentStatus(paymentStatusMessage(row?.status)),
      });
      await finishSuccessfulPayment(confirmed);
    } catch (err) {
      const msg = err?.message || String(err);
      toast({
        variant: 'destructive',
        title: 'Could not complete transfer',
        description: msg.includes('LEDGER_FUNDS') ? 'Insufficient M-PESA balance for this amount.' : msg,
      });
      try {
        audit.txAction('transfer_failed', Number(amount) || 0, 'failed', user?.email);
      } catch {
        /* ignore */
      }
    } finally {
      setSending(false);
      setPaymentStatus('');
    }
  };

  if (done && recipient) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
        className="flex flex-col items-center justify-center min-h-full px-4 py-20"
      >
        {/* Success icon with pulse ring */}
        <div className="relative mb-6">
          <motion.div
            className="absolute inset-0 rounded-full bg-primary/20"
            animate={{ scale: [1, 1.6, 1], opacity: [0.6, 0, 0.6] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeOut' }}
          />
          <div className="w-20 h-20 rounded-full gradient-green flex items-center justify-center relative z-10 glow-green">
            <motion.div
              initial={{ scale: 0, rotate: -30 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ delay: 0.2, duration: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <CheckCircle2 size={36} className="text-black" />
            </motion.div>
          </div>
        </div>

        {/* Sent label */}
        <motion.h2
          className="text-2xl font-bold text-foreground font-grotesk"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
        >
          Sent!
        </motion.h2>

        {/* Amount */}
        <motion.p
          className="text-muted-foreground text-sm mt-2 text-center"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
        >
          KSh {Number(amount).toLocaleString()} sent to {recipient.name}
        </motion.p>

        {/* Subtle hint */}
        <motion.p
          className="text-[10px] text-muted-foreground/50 mt-1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.55 }}
        >
          Tap to share receipt
        </motion.p>

        {/* Back button */}
        <motion.button
          onClick={() => navigate('/')}
          className="mt-8 gradient-green rounded-2xl px-8 py-3.5 text-black font-bold text-sm"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, ease: [0.34, 1.56, 0.64, 1] }}
          whileTap={{ scale: 0.97 }}
        >
          Back to Home
        </motion.button>
      </motion.div>
    );
  }

  return (
    <div className="px-4 py-4">
      {/* Step progress indicator */}
      {!done && (
        <div className="flex items-center gap-2 px-4 pt-4 pb-2">
          {[1, 2].map((s) => (
            <div
              key={s}
              className={`h-1 rounded-full transition-all duration-500 ${
                step >= s
                  ? 'bg-primary flex-[2]'
                  : 'bg-border flex-1'
              }`}
            />
          ))}
          <span className="text-[10px] text-muted-foreground font-medium ml-1 shrink-0">
            {step}/2
          </span>
        </div>
      )}


      {serverStepUp && recipient && serverStepUp.required_step_up === 'biometric' && (
        <BiometricStepUpModal
          open
          stepUpChallengeId={serverStepUp.step_up_challenge_id}
          actionType="payment_send"
          amount={Number(amount)}
          recipientLabel={recipient.name}
          actionLabel="Authorizing send"
          onSubmit={handleBiometricStepUpSubmit}
          onFallbackToPin={handleBiometricFallbackToPin}
          onCancel={handleBiometricCancel}
        />
      )}

      <AnimatePresence>
        {showAuth && recipient && (
          <AuthGate
            type="adaptive"
            amount={Number(amount)}
            recipient={recipient.name}
            actionType="send"
            onSuccess={handleAuthSuccess}
            onFailure={() => setShowAuth(false)}
            onCancel={() => setShowAuth(false)}
          />
        )}
        {serverStepUp && recipient && serverStepUp.required_step_up === 'pin' && (
          <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm px-4 pb-10">
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="w-full max-w-[430px] glass rounded-3xl p-5 border border-border"
            >
              <p className="text-sm text-center text-muted-foreground mb-4">
                {paymentStatus || 'We need one more verification step.'}
              </p>
              <PinPad
                mode="verify"
                onSuccess={handleServerStepUpPinSuccess}
                onFailure={() => setServerStepUp(null)}
              />
              <button
                type="button"
                onClick={() => setServerStepUp(null)}
                className="w-full mt-4 text-xs text-muted-foreground py-2"
              >
                Cancel
              </button>
            </motion.div>
          </motion.div>
        )}
        {serverStepUp && recipient && serverStepUp.required_step_up === 'otp' && (
          <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 backdrop-blur-sm px-4 pb-10">
            <motion.div
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              className="w-full max-w-[430px] glass rounded-3xl p-5 border border-border"
            >
              <p className="text-sm text-center text-muted-foreground mb-4">
                {paymentStatus || 'We need one more verification step.'}
              </p>
              <OTPEntry
                phone={SENDER_PHONE}
                loading={otpLoading}
                error={otpError}
                onSubmit={handleServerStepUpOtp}
                onResend={() => invokeEdgeFunction('sendOTP', { phone: SENDER_PHONE }).catch(() => {})}
              />
              <button
                type="button"
                onClick={() => setServerStepUp(null)}
                className="w-full mt-4 text-xs text-muted-foreground py-2"
              >
                Cancel
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {/* Step 1: Choose recipient */}
        {step === 1 && (
          <motion.div key="step1" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <div className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3 mb-3 border border-border">
              <Search size={15} className="text-muted-foreground shrink-0" />
              <input
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                placeholder="Search name or enter phone number…"
                value={search || phone}
                onChange={e => { setSearch(e.target.value); setPhone(e.target.value); }}
              />
            </div>

            {phone && phone.length >= 9 && !RECENT_CONTACTS.find(c => c.phone === phone) && (
              <motion.button initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                onClick={useManualPhone}
                className="flex items-center gap-3 w-full glass-card rounded-2xl px-4 py-3.5 mb-3 border border-border">
                <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
                  <Phone size={16} className="text-primary" />
                </div>
                <div className="flex-1 text-left">
                  <p className="text-sm font-semibold text-foreground">{phone}</p>
                  <p className="text-xs text-muted-foreground">Send to this number</p>
                </div>
                <ChevronRight size={14} className="text-muted-foreground" />
              </motion.button>
            )}

            <div className="flex items-center gap-2 mb-3">
              <Users size={13} className="text-muted-foreground" />
              <p className="text-ui-label">Recent</p>
            </div>

            {contactsLoading && RECENT_CONTACTS.length === 0 && (
              <div className="text-center py-6">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                <p className="text-xs text-muted-foreground">Loading contacts…</p>
              </div>
            )}
            {!contactsLoading && RECENT_CONTACTS.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">
                No contacts found. Enter a phone number below.
              </p>
            )}

            <div className="flex flex-col gap-2">
              {filtered.map(contact => (
                <motion.button
                  key={contact.phone}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => selectContact(contact)}
                  className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3.5 w-full text-left border border-border"
                >
                  <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 text-xs font-bold ${contact.color}`}>
                    {contact.initials}
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-foreground">{contact.name}</p>
                    <p className="text-xs text-muted-foreground">{contact.phone}</p>
                  </div>
                  <ChevronRight size={14} className="text-muted-foreground" />
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}

        {/* Step 2: Enter amount */}
        {step === 2 && recipient && (
          <motion.div key="step2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
            <button onClick={() => setStep(1)} className="flex items-center gap-1.5 text-xs text-muted-foreground mb-4">
              <ArrowLeft size={13} /> Back
            </button>

            <div className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3.5 mb-4 border border-border">
              <div className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 text-xs font-bold ${recipient.color}`}>
                {recipient.initials}
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{recipient.name}</p>
                <p className="text-xs text-muted-foreground">{recipient.phone}</p>
              </div>
            </div>

            <div className="text-center mb-4">
              <p className="text-ui-label mb-2">Amount (KSh)</p>
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

            <div className="flex gap-2 justify-center mb-4">
              {QUICK_AMOUNTS.map(q => (
                <button key={q} onClick={() => setAmount(String(q))}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                    amount === String(q) ? 'bg-primary/15 border-primary/30 text-primary' : 'bg-primary/8 border-primary/15 text-muted-foreground'
                  }`}>
                  {q.toLocaleString()}
                </button>
              ))}
            </div>

            <div className="glass-card rounded-2xl px-4 py-3.5 mb-4 border border-border">
              <p className="text-ui-label mb-2">Note (optional)</p>
              <input
                value={note}
                onChange={e => setNote(e.target.value)}
                maxLength={120}
                placeholder="e.g. Rent, lunch…"
                className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
              <p className="text-xs text-muted-foreground text-right mt-1">
                {note.length}/120
              </p>
            </div>

            <button
              disabled={!amount || sending}
              onClick={handleSendTap}
              className="w-full gradient-green rounded-2xl py-3 text-white font-bold text-sm disabled:opacity-30"
            >
              {sending ? (paymentStatus || 'Waiting for M-PESA confirmation...') : `Send KSh ${amount ? Number(amount).toLocaleString() : ''} to ${recipient.name}`}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}



