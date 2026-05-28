import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Phone, Lock, Eye, EyeOff, CheckCircle2, Loader2 } from 'lucide-react';
import { linkWallet } from '../../lib/mpesa';

export default function LinkWalletModal({ onClose, onLinked }) {
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);
  const [step, setStep] = useState('form'); // form | verifying | success
  const [error, setError] = useState('');

  const handleSubmit = () => {
    if (phone.length < 9) { setError('Enter a valid Safaricom number'); return; }
    if (pin.length !== 4) { setError('Preview confirmation PIN must be 4 digits'); return; }
    setError('');
    setStep('verifying');
    // Simulate network round-trip
    setTimeout(() => {
      linkWallet(phone.startsWith('07') ? '+254' + phone.slice(1) : phone);
      setStep('success');
      setTimeout(onLinked, 1500);
    }, 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={step === 'form' ? onClose : undefined} />

      <motion.div
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 400, damping: 40 }}
        className="relative w-full max-w-[430px] glass rounded-t-3xl px-5 pt-5 pb-10 z-10"
        style={{ borderTop: '1px solid rgba(0,200,83,0.15)' }}
      >
        <div className="w-10 h-1 rounded-full bg-muted mx-auto mb-5" />

        {step === 'form' && (
          <>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-bold text-foreground font-grotesk">Enable Preview Wallet</h2>
              <button onClick={onClose} className="w-8 h-8 rounded-xl surface2 flex items-center justify-center">
                <X size={14} className="text-muted-foreground" />
              </button>
            </div>

            <div className="glass-card border border-white/10 rounded-xl px-3 py-2.5 mb-5">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                <span className="font-semibold text-foreground">Preview link only.</span> Do not enter your M-Pesa PIN.
                This uses a local preview confirmation code; real linking requires Safaricom Daraja onboarding.
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Safaricom Phone Number</p>
                <div className="glass-card rounded-xl px-4 py-3 flex items-center gap-3">
                  <Phone size={15} className="text-muted-foreground shrink-0" />
                  <input
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="07XX XXX XXX"
                    className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    inputMode="tel"
                  />
                </div>
              </div>

              <div>
                <p className="text-xs text-muted-foreground font-medium mb-1.5">Preview confirmation PIN</p>
                <div className="glass-card rounded-xl px-4 py-3 flex items-center gap-3">
                  <Lock size={15} className="text-muted-foreground shrink-0" />
                  <input
                    value={pin}
                    onChange={e => setPin(e.target.value.slice(0, 4))}
                    type={showPin ? 'text' : 'password'}
                    placeholder="****"
                    className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground tracking-widest font-grotesk"
                    inputMode="numeric"
                  />
                  <button onClick={() => setShowPin(s => !s)}>
                    {showPin ? <EyeOff size={14} className="text-muted-foreground" /> : <Eye size={14} className="text-muted-foreground" />}
                  </button>
                </div>
              </div>
            </div>

            {error && <p className="text-xs text-red-400 mt-3">{error}</p>}

            <motion.button whileTap={{ scale: 0.97 }} onClick={handleSubmit}
              className="w-full gradient-green rounded-2xl py-4 text-black font-bold text-sm mt-5">
              Enable Preview Wallet
            </motion.button>
          </>
        )}

        {step === 'verifying' && (
          <div className="flex flex-col items-center py-8 gap-4">
            <div className="w-16 h-16 rounded-full gradient-green flex items-center justify-center glow-green animate-pulse">
              <Loader2 size={28} className="text-black animate-spin" />
            </div>
            <p className="text-base font-bold text-foreground font-grotesk">Linking preview wallet...</p>
            <p className="text-xs text-muted-foreground text-center">
              Preview only - no Safaricom account is being contacted
            </p>
          </div>
        )}

        {step === 'success' && (
          <div className="flex flex-col items-center py-8 gap-4">
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}
              className="w-16 h-16 rounded-full gradient-green flex items-center justify-center glow-green">
              <CheckCircle2 size={28} className="text-black" />
            </motion.div>
            <p className="text-base font-bold text-foreground font-grotesk">Preview Wallet Ready</p>
            <p className="text-xs text-muted-foreground text-center">
              A preview wallet is now active on this device.
            </p>
          </div>
        )}
      </motion.div>
    </div>
  );
}
