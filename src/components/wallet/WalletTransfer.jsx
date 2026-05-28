import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, ArrowRight, CheckCircle2, Clock, Shield, Mic, Loader2 } from 'lucide-react';
import { recordLedgerTransfer } from '../../lib/mpesa';
import { generateTxRef } from '../../lib/ledger';
import { initiateAndWaitForPayment } from '@/services/paymentService.js';
import VoiceBiometric from '../auth/VoiceBiometric';
import { useAuth } from '@/lib/AuthContext';
import { getClientDemoPolicy } from '@/config/clientSecurityPolicy.js';

const SENDER_PHONE = '+254712345678';

function toE164(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return `+${digits}`;
  if (digits.startsWith('0'))   return `+254${digits.slice(1)}`;
  return `+254${digits}`;
}

const CONTACTS = [
  { id: 1, name: 'John Kamau',    phone: '0712 345 678', avatar: 'JK' },
  { id: 2, name: 'Grace Wanjiku', phone: '0723 456 789', avatar: 'GW' },
  { id: 3, name: 'Peter Mwangi', phone: '0734 567 890', avatar: 'PM' },
  { id: 4, name: 'Mary Njeri',   phone: '0745 678 901', avatar: 'MN' },
];
const QUICK = [100, 200, 500, 1000, 2000, 5000];

export default function WalletTransfer({ balance }) {
  const { user } = useAuth();
  const [step,      setStep]      = useState(1);
  const [selected,  setSelected]  = useState(null);
  const [amount,    setAmount]    = useState('');
  const [note,      setNote]      = useState('');
  const [search,    setSearch]    = useState('');
  const [result,    setResult]    = useState(null);
  const [showVoice, setShowVoice] = useState(false);
  const [error,     setError]     = useState('');
  const [posting,   setPosting]   = useState(false);
  const [paymentStatus, setPaymentStatus] = useState('');

  const fee = !amount ? 0 : Number(amount) <= 100 ? 0 : Number(amount) <= 500 ? 10 : Number(amount) <= 1000 ? 13 : Number(amount) <= 2500 ? 25 : 45;
  const filtered = CONTACTS.filter(c => c.name.toLowerCase().includes(search.toLowerCase()) || c.phone.includes(search));

  const handleSend = async () => {
    if (posting) return;
    setPosting(true);
    setError('');
    setPaymentStatus('Starting M-PESA STK Push...');
    const ref = generateTxRef(SENDER_PHONE);
    const toPhone = toE164(selected.phone);
    const description = note ? `${note} → ${selected.name}` : `Transfer to ${selected.name}`;

    try {
      await initiateAndWaitForPayment({
        type:        'wallet_transfer',
        fromPhone:   SENDER_PHONE,
        toPhone,
        amount:      Number(amount),
        description,
        txRef:       ref,
        userId:      user?.id,
        idempotencyKey: `zuri_wallet_transfer_${ref}_${user?.id || 'anon'}`,
        metadata:    { recipient_name: selected.name, fee },
      }, {
        onStatus: (row) => {
          if (row?.status === 'processing') setPaymentStatus('Waiting for M-PESA confirmation...');
          else if (row?.status) setPaymentStatus(`Payment ${row.status}`);
        },
      });

      recordLedgerTransfer({
        ref,
        toName: selected.name,
        toPhone: selected.phone,
        amount: Number(amount),
        fee,
        note: note || '',
      });

      setResult({ ref, fee, newBalance: balance - Number(amount) - fee });
      setStep(4);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setPosting(false);
      setPaymentStatus('');
    }
  };

  const handleVoiceSuccess = () => { setShowVoice(false); handleSend(); };

  if (step === 4 && result) return (
    <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col items-center py-10">
      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}
        className="w-20 h-20 rounded-full gradient-green flex items-center justify-center mb-5 glow-green">
        <CheckCircle2 size={36} className="text-black" />
      </motion.div>
      <h2 className="text-2xl font-bold font-grotesk text-foreground">Sent!</h2>
      <p className="text-sm text-muted-foreground mt-2 text-center">
        KSh {Number(amount).toLocaleString()} to {selected?.name}
      </p>
      <div className="flex items-center gap-1 mt-2">
        <Clock size={11} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Ref: {result.ref}</span>
      </div>
      <div className="glass-card rounded-2xl px-5 py-3.5 mt-4 w-full space-y-1.5">
        <Row label="Amount" value={`KSh ${Number(amount).toLocaleString()}`} />
        <Row label="Fee" value={`KSh ${result.fee}`} />
        <Row label="Ledger Ref" value={result.ref} highlight />
      </div>
      <button onClick={() => { setStep(1); setAmount(''); setNote(''); setSelected(null); setResult(null); }}
        className="mt-6 gradient-green rounded-2xl px-8 py-3 text-black font-bold text-sm">
        New Transfer
      </button>
    </motion.div>
  );

  return (
    <div>
      <AnimatePresence>
        {showVoice && selected && (
          <VoiceBiometric amount={amount} recipient={`${selected.name} · ${selected.phone}`}
            onSuccess={handleVoiceSuccess} onCancel={() => setShowVoice(false)}
            onFallback={() => { setShowVoice(false); handleSend(); }} />
        )}
      </AnimatePresence>

      <AnimatePresence mode="wait">
        {step === 1 && (
          <motion.div key="s1" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex items-center gap-2 glass-card rounded-xl px-3 py-2.5 mb-3">
              <Search size={13} className="text-muted-foreground" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search contact or phone…"
                className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" />
            </div>
            <p className="text-[11px] text-muted-foreground font-semibold uppercase tracking-wider mb-2">Contacts</p>
            <div className="glass-card rounded-2xl overflow-hidden">
              {filtered.map((c, i) => (
                <button key={c.id} onClick={() => { setSelected(c); setStep(2); }}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-left transition-all active:bg-muted/30 ${i < filtered.length - 1 ? 'border-b border-border/40' : ''}`}>
                  <div className="w-9 h-9 rounded-2xl gradient-green flex items-center justify-center shrink-0">
                    <span className="text-black text-[11px] font-bold">{c.avatar}</span>
                  </div>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-foreground">{c.name}</p>
                    <p className="text-xs text-muted-foreground">{c.phone}</p>
                  </div>
                  <ArrowRight size={14} className="text-muted-foreground" />
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {step === 2 && selected && (
          <motion.div key="s2" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            <div className="flex items-center gap-3 glass-card rounded-2xl px-4 py-3 mb-4">
              <div className="w-9 h-9 rounded-2xl gradient-green flex items-center justify-center">
                <span className="text-black text-[11px] font-bold">{selected.avatar}</span>
              </div>
              <div>
                <p className="text-sm font-semibold text-foreground">{selected.name}</p>
                <p className="text-xs text-muted-foreground">{selected.phone}</p>
              </div>
            </div>

            <div className="text-center mb-4">
              <p className="text-xs text-muted-foreground mb-2">Amount (KSh)</p>
              <div className="flex items-baseline justify-center gap-2">
                <span className="text-xl text-primary font-grotesk font-semibold">KSh</span>
                <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
                  placeholder="0"
                  className="bg-transparent text-4xl font-bold font-grotesk text-foreground outline-none text-center w-36" />
              </div>
              {amount && <p className="text-xs text-muted-foreground mt-1">Fee: KSh {fee} · Total: KSh {(Number(amount) + fee).toLocaleString()}</p>}
            </div>

            <div className="grid grid-cols-3 gap-2 mb-4">
              {QUICK.map(a => (
                <button key={a} onClick={() => setAmount(String(a))}
                  className={`py-2 rounded-xl text-xs font-semibold transition-all ${amount === String(a) ? 'bg-primary text-black' : 'surface2 text-muted-foreground border border-border/50'}`}>
                  {a.toLocaleString()}
                </button>
              ))}
            </div>

            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Add a note (optional)"
              className="w-full glass-card rounded-xl px-4 py-3 text-xs text-foreground placeholder:text-muted-foreground outline-none mb-4" />

            <button disabled={!amount || Number(amount) <= 0} onClick={() => setStep(3)}
              className="w-full gradient-green rounded-2xl py-3.5 text-black font-bold text-sm disabled:opacity-30">
              Continue
            </button>
            <button onClick={() => setStep(1)} className="w-full text-center text-xs text-muted-foreground py-2 mt-1">← Back</button>
          </motion.div>
        )}

        {step === 3 && selected && (
          <motion.div key="s3" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}>
            <div className="glass-card rounded-2xl p-4 mb-3">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-3">Confirm Transfer</p>
              <Row label="To" value={`${selected.name} · ${selected.phone}`} />
              <Row label="Amount" value={`KSh ${Number(amount).toLocaleString()}`} highlight />
              <Row label="Fee" value={`KSh ${fee}`} />
              <Row label="Total" value={`KSh ${(Number(amount) + fee).toLocaleString()}`} />
              {note && <Row label="Note" value={note} />}
            </div>
            {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
            <div className="flex items-center gap-2 glass-card rounded-xl px-3 py-2.5 mb-3">
              <Shield size={12} className="text-primary" />
              <p className="text-[11px] text-muted-foreground">End-to-end encrypted · Fraud monitoring active</p>
            </div>
            {/* Primary CTA = server-authoritative payment flow (PIN/biometric
                step-up is enforced server-side). Voice biometric is exposed as
                a secondary "preview" affordance only when the client demo
                policy is non-hardened (Labs / dev surfaces). */}
            <button disabled={posting} onClick={handleSend}
              className="w-full gradient-green rounded-2xl py-3.5 flex items-center justify-center gap-2 text-black font-bold text-sm mb-2 disabled:opacity-50">
              {posting ? <Loader2 size={17} className="animate-spin" /> : <Shield size={17} />}
              {posting ? (paymentStatus || 'Waiting for M-PESA confirmation...') : 'Confirm & Send'}
            </button>
            {!getClientDemoPolicy().hardenedSurface && (
              <button disabled={posting} onClick={() => setShowVoice(true)}
                className="w-full surface2 border border-border/50 rounded-2xl py-2.5 text-xs font-semibold text-muted-foreground disabled:opacity-40 flex items-center justify-center gap-1.5">
                <Mic size={13} className="text-muted-foreground" />
                Use voice biometric (preview)
              </button>
            )}
            <button onClick={() => setStep(2)} className="w-full text-center text-xs text-muted-foreground py-2">← Back</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Row({ label, value, highlight }) {
  return (
    <div className="flex justify-between py-2 border-b border-border/30 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-xs font-semibold ${highlight ? 'text-primary font-grotesk' : 'text-foreground'}`}>{value}</span>
    </div>
  );
}
