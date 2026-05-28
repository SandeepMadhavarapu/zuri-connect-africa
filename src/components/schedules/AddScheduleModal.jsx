import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Check } from 'lucide-react';

const CATEGORIES = [
  { key: 'utilities', label: 'Utilities', emoji: '💡', color: '#00C853' },
  { key: 'rent', label: 'Rent', emoji: '🏠', color: '#2196F3' },
  { key: 'subscription', label: 'Subscription', emoji: '📺', color: '#AB47BC' },
  { key: 'loan', label: 'Loan Repay', emoji: '🏦', color: '#FFB300' },
  { key: 'insurance', label: 'Insurance', emoji: '🛡️', color: '#26C6DA' },
  { key: 'other', label: 'Other', emoji: '📦', color: '#78909C' },
];

const POPULAR = [
  { name: 'Kenya Power', paybill: '888880', emoji: '💡', category: 'utilities', color: '#00C853' },
  { name: 'Nairobi Water', paybill: '444400', emoji: '💧', category: 'utilities', color: '#26C6DA' },
  { name: 'KPLC Prepaid', paybill: '888888', emoji: '⚡', category: 'utilities', color: '#FFB300' },
  { name: 'DStv', paybill: '777300', emoji: '📺', category: 'subscription', color: '#AB47BC' },
  { name: 'Zuku', paybill: '222111', emoji: '🌐', category: 'subscription', color: '#2196F3' },
  { name: 'Rent', paybill: '', emoji: '🏠', category: 'rent', color: '#2196F3' },
];

export default function AddScheduleModal({ onClose, onAdd }) {
  const [step, setStep] = useState(1); // 1: pick template, 2: fill details
  const [form, setForm] = useState({
    name: '', paybill: '', account: '', amount: '',
    dayOfMonth: '1', category: 'utilities', emoji: '💡', color: '#00C853',
  });

  const selectTemplate = (t) => {
    setForm(f => ({ ...f, name: t.name, paybill: t.paybill, emoji: t.emoji, category: t.category, color: t.color }));
    setStep(2);
  };

  const cat = CATEGORIES.find(c => c.key === form.category) || CATEGORIES[0];

  const handleSubmit = () => {
    if (!form.name || !form.amount || !form.dayOfMonth) return;
    const nextDate = (() => {
      const now = new Date();
      const d = parseInt(form.dayOfMonth);
      let target = new Date(now.getFullYear(), now.getMonth(), d);
      if (target <= now) target = new Date(now.getFullYear(), now.getMonth() + 1, d);
      return target.toISOString().split('T')[0];
    })();
    onAdd({ ...form, amount: Number(form.amount), dayOfMonth: parseInt(form.dayOfMonth), frequency: 'monthly', nextDate, paused: false });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 400, damping: 40 }}
        className="relative w-full max-w-[430px] glass rounded-t-3xl px-5 pt-5 pb-10 z-10 max-h-[85vh] overflow-y-auto"
        style={{ borderTop: '1px solid rgba(0,200,83,0.15)' }}
      >
        <div className="w-10 h-1 rounded-full bg-muted mx-auto mb-5" />

        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-bold text-foreground font-grotesk">
            {step === 1 ? 'Choose a Biller' : 'Schedule Details'}
          </h2>
          <button onClick={onClose} className="w-8 h-8 rounded-xl surface2 flex items-center justify-center">
            <X size={14} className="text-muted-foreground" />
          </button>
        </div>

        {step === 1 && (
          <>
            <p className="text-xs text-muted-foreground mb-3">Popular billers</p>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {POPULAR.map(t => (
                <button key={t.name} onClick={() => selectTemplate(t)}
                  className="glass-card rounded-2xl p-3 flex flex-col items-center gap-1.5 active:scale-95 transition-all">
                  <span className="text-2xl">{t.emoji}</span>
                  <span className="text-[11px] font-semibold text-foreground text-center leading-tight">{t.name}</span>
                  {t.paybill && <span className="text-[10px] text-muted-foreground">{t.paybill}</span>}
                </button>
              ))}
            </div>
            <button onClick={() => setStep(2)}
              className="w-full surface2 border border-border/50 rounded-2xl py-3 text-sm font-semibold text-muted-foreground">
              + Enter manually
            </button>
          </>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {/* Category */}
            <div>
              <p className="text-xs text-muted-foreground font-medium mb-2">Category</p>
              <div className="flex gap-2 flex-wrap">
                {CATEGORIES.map(c => (
                  <button key={c.key} onClick={() => setForm(f => ({ ...f, category: c.key, emoji: c.emoji, color: c.color }))}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all ${
                      form.category === c.key ? 'bg-primary text-black border-primary' : 'border-border/50 text-muted-foreground'
                    }`}>
                    {c.emoji} {c.label}
                  </button>
                ))}
              </div>
            </div>

            {[
              { label: 'Biller name', key: 'name', placeholder: 'e.g. Kenya Power' },
              { label: 'Paybill number', key: 'paybill', placeholder: 'e.g. 888880' },
              { label: 'Account number', key: 'account', placeholder: 'e.g. 12345678' },
            ].map(({ label, key, placeholder }) => (
              <div key={key}>
                <p className="text-xs text-muted-foreground font-medium mb-1.5">{label}</p>
                <input
                  value={form[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  placeholder={placeholder}
                  className="w-full glass-card rounded-xl px-4 py-3 text-sm text-foreground bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </div>
            ))}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Amount (KSh)</p>
                <input
                  type="number"
                  value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0"
                  className="w-full glass-card rounded-xl px-4 py-3 text-sm font-grotesk font-bold text-foreground bg-transparent outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Day of month</p>
                <select
                  value={form.dayOfMonth}
                  onChange={e => setForm(f => ({ ...f, dayOfMonth: e.target.value }))}
                  className="w-full glass-card rounded-xl px-4 py-3 text-sm text-foreground bg-transparent outline-none appearance-none"
                  style={{ background: 'rgba(19,27,19,0.6)' }}
                >
                  {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                    <option key={d} value={d} style={{ background: '#0e150e' }}>{d}</option>
                  ))}
                </select>
              </div>
            </div>

            <p className="text-[10px] text-muted-foreground text-center mt-2">
              Saved on this device only — payments are not auto-executed. You&apos;ll be prompted to confirm with
              biometric or PIN on the due date.
            </p>
            <motion.button
              whileTap={{ scale: 0.97 }}
              onClick={handleSubmit}
              type="button"
              aria-label="Save schedule to this device"
              className="w-full gradient-green rounded-2xl py-4 flex items-center justify-center gap-2 text-black font-bold text-sm mt-1"
            >
              <Check size={18} />
              Save Schedule
            </motion.button>
          </div>
        )}
      </motion.div>
    </div>
  );
}