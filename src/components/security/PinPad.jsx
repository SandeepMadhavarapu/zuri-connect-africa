import { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Delete, Lock, AlertTriangle, Loader2 } from 'lucide-react';
import {
  hashPin,
  verifyPin,
  getStoredPinHash,
  storePinHash,
  recordFailedAttempt,
  clearFailedAttempts,
  getRemainingLockout,
  getFailedAttempts,
} from '@/lib/security';
import { getClientDemoPolicy } from '@/config/clientSecurityPolicy.js';

const PIN_LENGTH = 6;
const KEYS = ['1','2','3','4','5','6','7','8','9','','0','⌫'];

export default function PinPad({ onSuccess, onFailure, onForgot, mode = 'verify' }) {
  // mode: 'verify' | 'setup' | 'confirm' (for setup confirmation step)
  const [pin,          setPin]          = useState('');
  const [status,       setStatus]       = useState('idle'); // idle | checking | error | locked | success
  const [shake,        setShake]        = useState(false);
  const [lockoutSecs,  setLockoutSecs]  = useState(0);
  const [attempts,     setAttempts]     = useState(0);
  const [setupPhase,   setSetupPhase]   = useState('enter'); // enter | confirm
  const [firstPin,     setFirstPin]     = useState('');
  const lockTimerRef = useRef(null);

  // ── Lockout countdown ──────────────────────────────────────────────────────
  useEffect(() => {
    const { locked, remainingSeconds } = getRemainingLockout();
    if (locked) {
      setStatus('locked');
      setLockoutSecs(remainingSeconds);
    }
  }, []);

  useEffect(() => {
    if (status !== 'locked') return;
    lockTimerRef.current = setInterval(() => {
      const { locked, remainingSeconds } = getRemainingLockout();
      if (!locked) {
        clearInterval(lockTimerRef.current);
        setStatus('idle');
        setLockoutSecs(0);
        setAttempts(0);
      } else {
        setLockoutSecs(remainingSeconds);
      }
    }, 1000);
    return () => clearInterval(lockTimerRef.current);
  }, [status]);

  // ── Auto-submit when PIN is full ───────────────────────────────────────────
  useEffect(() => {
    if (pin.length === PIN_LENGTH) {
      const t = setTimeout(() => handleSubmit(pin), 100);
      return () => clearTimeout(t);
    }
  }, [pin]);

  const triggerShake = () => {
    setShake(true);
    if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
    setTimeout(() => setShake(false), 600);
  };

  const handleKey = useCallback((key) => {
    if (status === 'checking' || status === 'locked' || status === 'success') return;
    if (key === '⌫') {
      if (navigator.vibrate) navigator.vibrate(6);
      setPin(p => p.slice(0, -1));
    } else if (pin.length < PIN_LENGTH && key !== '') {
      if (navigator.vibrate) navigator.vibrate(8);
      setPin(p => p + key);
    }
  }, [pin, status]);

  const handleSubmit = async (currentPin) => {
    if (status === 'checking' || status === 'locked') return;
    setStatus('checking');

    // Artificial 600–900ms delay for security UX realism
    await new Promise(r => setTimeout(r, 600 + Math.random() * 300));

    if (mode === 'setup') {
      if (setupPhase === 'enter') {
        setFirstPin(currentPin);
        setSetupPhase('confirm');
        setPin('');
        setStatus('idle');
        return;
      }
      // Confirmation phase
      if (currentPin === firstPin) {
        await storePinHash(currentPin);
        setStatus('success');
        clearFailedAttempts();
        setTimeout(() => onSuccess?.(currentPin), 600);
      } else {
        triggerShake();
        setStatus('error');
        setPin('');
        setSetupPhase('enter');
        setFirstPin('');
        setTimeout(() => setStatus('idle'), 1200);
      }
      return;
    }

    // ── Verify mode ──────────────────────────────────────────────────────────
    const storedHash = getStoredPinHash();

    // If no PIN is set yet, optional dev-only default PIN (never in staging/production).
    let correct = false;
    if (!storedHash) {
      if (getClientDemoPolicy().allowDefaultDemoPin) {
        const demoHash = await hashPin('123456');
        correct = await verifyPin(currentPin, demoHash);
      } else {
        correct = false;
      }
    } else {
      correct = await verifyPin(currentPin, storedHash);
    }

    if (correct) {
      clearFailedAttempts();
      setStatus('success');
      setTimeout(() => onSuccess?.(currentPin), 600);
    } else {
      const result = recordFailedAttempt();
      setAttempts(result.attempts);
      triggerShake();
      setStatus('error');
      setPin('');

      if (result.locked) {
        setStatus('locked');
        setLockoutSecs(Math.ceil((result.lockoutUntil - Date.now()) / 1000));
        onFailure?.('locked');
      } else {
        setTimeout(() => setStatus('idle'), 1200);
        onFailure?.('wrong_pin');
      }
    }
  };

  const remaining = PIN_LENGTH - pin.length;
  const attemptsLeft = Math.max(0, 5 - getFailedAttempts());

  // ── Heading ────────────────────────────────────────────────────────────────
  const getHeading = () => {
    if (mode === 'setup') {
      return setupPhase === 'enter' ? 'Create PIN' : 'Confirm PIN';
    }
    return 'Enter PIN';
  };

  const getSub = () => {
    if (mode === 'setup') {
      return setupPhase === 'enter'
        ? 'Choose a 6-digit PIN to secure your account'
        : 'Re-enter your PIN to confirm';
    }
    return 'Enter your 6-digit security PIN';
  };

  return (
    <div className="flex flex-col items-center w-full">
      {/* Heading */}
      <div className="flex items-center gap-2 mb-1">
        <Lock size={14} className="text-primary" />
        <p className="text-sm font-semibold text-foreground font-grotesk">{getHeading()}</p>
      </div>
      <p className="text-[11px] text-muted-foreground mb-5 text-center">{getSub()}</p>

      {/* Lockout state */}
      <AnimatePresence>
        {status === 'locked' && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-2 bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3 mb-4 w-full"
          >
            <AlertTriangle size={14} className="text-red-400 shrink-0" />
            <div>
              <p className="text-xs text-red-400 font-semibold">Account temporarily locked</p>
              <p className="text-[11px] text-red-300/70 mt-0.5">
                Too many failed attempts. Unlocks in {Math.floor(lockoutSecs / 60)}:{String(lockoutSecs % 60).padStart(2,'0')}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* PIN dots */}
      <motion.div
        animate={shake ? { x: [-8, 8, -8, 8, -6, 6, -4, 4, 0] } : { x: 0 }}
        transition={{ duration: 0.5 }}
        className="flex items-center gap-4 mb-6"
      >
        {Array.from({ length: PIN_LENGTH }).map((_, i) => {
          const filled = i < pin.length;
          const isActive = i === pin.length;
          return (
            <motion.div
              key={i}
              animate={{
                scale: filled ? 1.15 : 1,
                backgroundColor: status === 'error'
                  ? 'rgba(224, 82, 82, 0.8)'
                  : status === 'success'
                  ? 'rgb(46, 204, 113)'
                  : filled
                  ? 'rgb(46, 204, 113)'
                  : 'rgba(255,255,255,0.1)',
              }}
              transition={{ duration: 0.15 }}
              className={`w-3.5 h-3.5 rounded-full transition-all ${isActive && status === 'idle' ? 'ring-2 ring-primary/40' : ''}`}
            />
          );
        })}
      </motion.div>

      {/* Checking / Success feedback */}
      <AnimatePresence>
        {status === 'checking' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-4">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="text-primary animate-spin" />
              <span className="text-xs text-muted-foreground">Verifying…</span>
            </div>
          </motion.div>
        )}
        {status === 'error' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mb-3">
            <p className="text-xs text-red-400 text-center">
              Incorrect PIN · {attemptsLeft} attempt{attemptsLeft !== 1 ? 's' : ''} remaining
            </p>
          </motion.div>
        )}
        {status === 'success' && (
          <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="mb-4">
            <p className="text-xs text-primary text-center font-semibold">✓ Verified</p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Keypad */}
      <div className="grid grid-cols-3 gap-3 w-full max-w-[280px]">
        {KEYS.map((key, idx) => {
          if (key === '') return <div key={idx} />;
          return (
            <motion.button
              key={idx}
              whileTap={{ scale: key !== '' ? 0.88 : 1 }}
              onClick={() => handleKey(key)}
              disabled={status === 'locked' || status === 'checking' || status === 'success'}
              className={`h-14 rounded-2xl flex items-center justify-center text-lg font-semibold transition-all
                ${key === '⌫'
                  ? 'text-muted-foreground'
                  : 'glass-card text-foreground active:bg-primary/15'
                }
                disabled:opacity-30`}
              style={key !== '⌫' ? { border: '1px solid rgba(255,255,255,0.07)' } : {}}
            >
              {key === '⌫' ? <Delete size={18} className="text-muted-foreground" /> : key}
            </motion.button>
          );
        })}
      </div>

      {/* Forgot PIN */}
      {mode === 'verify' && onForgot && (
        <button
          onClick={onForgot}
          className="mt-5 text-[11px] text-primary/70 hover:text-primary transition-colors"
        >
          Forgot PIN?
        </button>
      )}

      {/* Demo hint */}
      <p className="mt-4 text-[10px] text-muted-foreground/40 text-center">
        {mode === 'verify'
          ? getClientDemoPolicy().allowDefaultDemoPin
            ? 'Demo · enter 123456 to continue'
            : 'PIN is hashed — set a PIN in Security if you have not yet'
          : 'PIN is hashed — never stored in plaintext'}
      </p>
    </div>
  );
}