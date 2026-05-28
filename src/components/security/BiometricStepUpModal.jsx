/**
 * BiometricStepUpModal — polished UX for action-bound WebAuthn step-up.
 *
 * Copy follows the security review wording:
 *   Title:   "Confirm securely"
 *   Body:    "Use Face ID, Touch ID, Windows Hello, or your device passkey to approve this action."
 *   Note:    "Your biometric data stays on your device."
 *   Success: "Verified securely"
 *   Failure: "Verification failed. Try again or use PIN."
 *   Cancel:  "Authorization cancelled. No payment was sent."
 *
 * The modal never claims success until `useBiometricStepUp` enters the
 * `verified` state, which only happens after the server confirms via the
 * onSubmit callback (e.g. completeServerStepUp).
 */

import { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Fingerprint, ShieldCheck, AlertCircle, Loader2, X, Lock } from 'lucide-react';
import useBiometricStepUp, { BIOMETRIC_STEP_UP_STATES } from '@/hooks/useBiometricStepUp.js';

const TITLE = 'Confirm securely';
const BODY = 'Use Face ID, Touch ID, Windows Hello, or your device passkey to approve this action.';
const NOTE = 'Your biometric data stays on your device.';
const SUCCESS_TITLE = 'Verified securely';
const FAILURE_TITLE = 'Verification failed. Try again or use PIN.';
const CANCEL_TITLE = 'Authorization cancelled. No payment was sent.';
const UNAVAILABLE_TITLE = 'Biometric unavailable on this device';

function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return '';
  try {
    return `KSh ${n.toLocaleString('en-KE')}`;
  } catch {
    return `KSh ${n}`;
  }
}

export default function BiometricStepUpModal({
  open,
  stepUpChallengeId,
  actionType,
  binding = {},
  amount,
  recipientLabel,
  actionLabel,
  onSubmit,
  onVerified,
  onCancel,
  onFallbackToPin,
  autoStart = true,
}) {
  const { state, errorMessage, isBusy, start, reset, cancel } = useBiometricStepUp({
    onSubmit,
    onVerified,
    onCancel,
  });

  useEffect(() => {
    if (!open) return;
    if (!autoStart) return;
    if (state !== BIOMETRIC_STEP_UP_STATES.IDLE) return;
    start({ stepUpChallengeId, actionType, binding });
  }, [open, autoStart, state, stepUpChallengeId, actionType, binding, start]);

  useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  if (!open) return null;

  const showRetry = state === BIOMETRIC_STEP_UP_STATES.FAILED;
  const showFallback = state === BIOMETRIC_STEP_UP_STATES.UNAVAILABLE
    || state === BIOMETRIC_STEP_UP_STATES.FAILED
    || state === BIOMETRIC_STEP_UP_STATES.CANCELLED;
  const blockClose = isBusy;
  const safeRecipient = recipientLabel ? String(recipientLabel) : '';
  const amountText = formatAmount(amount);

  function handleClose() {
    if (blockClose) return;
    cancel();
  }

  function handleFallback() {
    if (blockClose) return;
    if (typeof onFallbackToPin === 'function') {
      onFallbackToPin();
    }
  }

  function handleRetry() {
    if (blockClose) return;
    reset();
    start({ stepUpChallengeId, actionType, binding });
  }

  return (
    <AnimatePresence>
      <motion.div
        key="biometric-step-up"
        className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center px-4 pb-8 sm:pb-0"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="biometric-step-up-title"
      >
        <div
          className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          onClick={handleClose}
          aria-hidden
        />

        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 32 }}
          className="relative w-full max-w-[430px] glass-card rounded-3xl p-6 border border-primary/15 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={handleClose}
            disabled={blockClose}
            aria-label="Close authorization modal"
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-white/8 flex items-center justify-center hover:bg-white/15 disabled:opacity-30 transition-all"
          >
            <X size={14} className="text-muted-foreground" />
          </button>

          {(amountText || safeRecipient || actionLabel) && (
            <div className="glass-card rounded-2xl px-4 py-3 mb-4 flex items-center justify-between" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
              <div className="min-w-0 flex-1 pr-2">
                <p className="text-[10px] text-muted-foreground uppercase tracking-widest">{actionLabel || 'Authorizing'}</p>
                <p className="text-sm font-semibold text-foreground truncate mt-0.5">{safeRecipient || '—'}</p>
              </div>
              {amountText && (
                <p className="text-base font-bold text-primary font-grotesk shrink-0">{amountText}</p>
              )}
            </div>
          )}

          <div className="flex flex-col items-center">
            <motion.div
              className={`w-16 h-16 rounded-3xl flex items-center justify-center border ${
                state === BIOMETRIC_STEP_UP_STATES.VERIFIED
                  ? 'bg-primary/15 border-primary/30'
                  : state === BIOMETRIC_STEP_UP_STATES.FAILED || state === BIOMETRIC_STEP_UP_STATES.CANCELLED || state === BIOMETRIC_STEP_UP_STATES.UNAVAILABLE
                    ? 'bg-red-400/10 border-red-400/30'
                    : 'bg-primary/10 border-primary/20'
              }`}
              animate={isBusy ? { scale: [1, 1.05, 1] } : undefined}
              transition={isBusy ? { duration: 1.4, repeat: Infinity } : undefined}
            >
              {state === BIOMETRIC_STEP_UP_STATES.VERIFIED ? (
                <ShieldCheck size={28} className="text-primary" />
              ) : state === BIOMETRIC_STEP_UP_STATES.FAILED || state === BIOMETRIC_STEP_UP_STATES.UNAVAILABLE ? (
                <AlertCircle size={28} className="text-red-400" />
              ) : state === BIOMETRIC_STEP_UP_STATES.CANCELLED ? (
                <Lock size={28} className="text-red-400" />
              ) : state === BIOMETRIC_STEP_UP_STATES.SUBMITTING ? (
                <Loader2 size={28} className="text-primary animate-spin" />
              ) : (
                <Fingerprint size={28} className="text-primary" />
              )}
            </motion.div>

            <h2
              id="biometric-step-up-title"
              className="text-lg font-bold text-foreground mt-4 text-center font-grotesk"
            >
              {state === BIOMETRIC_STEP_UP_STATES.VERIFIED ? SUCCESS_TITLE
                : state === BIOMETRIC_STEP_UP_STATES.FAILED ? FAILURE_TITLE
                : state === BIOMETRIC_STEP_UP_STATES.CANCELLED ? CANCEL_TITLE
                : state === BIOMETRIC_STEP_UP_STATES.UNAVAILABLE ? UNAVAILABLE_TITLE
                : TITLE}
            </h2>

            <p className="text-sm text-muted-foreground text-center mt-2 px-2 leading-relaxed">
              {state === BIOMETRIC_STEP_UP_STATES.VERIFIED
                ? 'Continuing your payment now…'
                : state === BIOMETRIC_STEP_UP_STATES.SUBMITTING
                  ? 'Confirming with our server…'
                  : state === BIOMETRIC_STEP_UP_STATES.SIGNING || state === BIOMETRIC_STEP_UP_STATES.REQUESTING
                    ? 'Approve with Face ID, Touch ID, Windows Hello, or your device passkey.'
                    : state === BIOMETRIC_STEP_UP_STATES.FAILED
                      ? (errorMessage || 'Verification failed. Try again or use PIN.')
                      : state === BIOMETRIC_STEP_UP_STATES.CANCELLED
                        ? 'No payment was sent. You can try biometrics again or use your PIN.'
                        : state === BIOMETRIC_STEP_UP_STATES.UNAVAILABLE
                          ? (errorMessage || 'Use your PIN to authorize this action.')
                          : BODY}
            </p>

            {state !== BIOMETRIC_STEP_UP_STATES.VERIFIED && (
              <p className="text-[11px] text-muted-foreground/80 mt-3 text-center px-3">
                {NOTE}
              </p>
            )}

            <div className="w-full flex flex-col gap-2 mt-5">
              {showRetry && (
                <motion.button
                  type="button"
                  onClick={handleRetry}
                  whileTap={{ scale: 0.97 }}
                  className="w-full py-3 rounded-2xl gradient-green text-black font-semibold text-sm"
                >
                  Try again
                </motion.button>
              )}

              {showFallback && typeof onFallbackToPin === 'function' && (
                <motion.button
                  type="button"
                  onClick={handleFallback}
                  whileTap={{ scale: 0.97 }}
                  className="w-full py-3 rounded-2xl glass border border-border text-foreground font-semibold text-sm"
                >
                  Use PIN instead
                </motion.button>
              )}

              {!isBusy && state !== BIOMETRIC_STEP_UP_STATES.VERIFIED && (
                <button
                  type="button"
                  onClick={handleClose}
                  className="w-full py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
