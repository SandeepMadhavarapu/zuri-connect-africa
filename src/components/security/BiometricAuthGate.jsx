import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Smartphone, Fingerprint, CheckCircle2, AlertCircle, Loader2, Lock } from 'lucide-react';
import {
  isBiometricSupported,
  isBiometricEnrolled,
  authenticateBiometric,
} from '@/lib/biometricAuth';
import { recordSuccessfulBiometricAuth, recordAuthFailure, shouldSkipBiometricPrompt } from '@/lib/deviceTrust';
import { useAuth } from '@/lib/AuthContext';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

export default function BiometricAuthGate({
  isOpen,
  onSuccess,
  onFallbackToPin,
  userId,
  transactionType = 'transaction',
}) {
  const { user } = useAuth();
  const userEmail = userId || user?.email;

  const [stage, setStage] = useState('prompt'); // prompt | authenticating | success | error
  const [error, setError] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const [supported, setSupported] = useState(false);
  const [enrolled, setEnrolled] = useState(false);

  useEffect(() => {
    if (!isOpen) return;

    const check = async () => {
      const isSupported = isBiometricSupported();
      setSupported(isSupported);

      if (isSupported && userEmail) {
        const isEnrolled = isBiometricEnrolled(userEmail);
        setEnrolled(isEnrolled);

        // Auto-start if biometric is enrolled and device is trusted
        if (isEnrolled && shouldSkipBiometricPrompt()) {
          handleAuthenticate();
        }
      }
    };

    check();
  }, [isOpen, userEmail]);

  const handleAuthenticate = async () => {
    if (!supported || !enrolled || !userEmail) {
      onFallbackToPin?.();
      return;
    }

    setStage('authenticating');
    setError(null);

    try {
      const { data, error: sessionError } = await getSupabaseBrowserClient().auth.getSession();
      if (sessionError || !data?.session?.access_token) {
        throw new Error('Please sign in again before using biometrics.');
      }

      const result = await authenticateBiometric(userEmail, data.session.access_token);

      if (result.success) {
        recordSuccessfulBiometricAuth();
        setStage('success');
        setTimeout(() => {
          onSuccess?.(result);
        }, 600);
      } else {
        recordAuthFailure();
        setError(result.error || 'Biometric authentication failed');
        setRetryCount(prev => prev + 1);

        if (retryCount >= 2) {
          setStage('fallback');
        } else {
          setStage('error');
        }
      }
    } catch (e) {
      recordAuthFailure();
      console.error('[BiometricAuthGate] Error:', e?.message || 'biometric_auth_failed');
      setError(e?.message || 'Biometric authentication failed');
      setRetryCount(prev => prev + 1);

      if (retryCount >= 2) {
        setStage('fallback');
      } else {
        setStage('error');
      }
    }
  };

  const handleRetry = () => {
    setStage('prompt');
    setError(null);
    handleAuthenticate();
  };

  const handleFallback = () => {
    onFallbackToPin?.();
  };

  if (!isOpen) return null;

  if (!supported || !enrolled) {
    return (
      <BiometricAuthOverlay stage="unsupported" onFallback={handleFallback} />
    );
  }

  return (
    <BiometricAuthOverlay
      stage={stage}
      error={error}
      retryCount={retryCount}
      transactionType={transactionType}
      onAuthenticate={handleAuthenticate}
      onRetry={handleRetry}
      onFallback={handleFallback}
    />
  );
}

// ─── Overlay UI ───────────────────────────────────────────────────────

function BiometricAuthOverlay({
  stage,
  error,
  retryCount,
  transactionType,
  onAuthenticate,
  onRetry,
  onFallback,
}) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => stage === 'error' && onFallback?.()}
      />

      {/* Bottom sheet */}
      <motion.div
        className="relative w-full bg-gradient-to-t from-background via-card to-card rounded-t-3xl p-6 border-t border-white/5"
        initial={{ y: 400 }}
        animate={{ y: 0 }}
        exit={{ y: 400 }}
        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
      >
        <AnimatePresence mode="wait">
          {/* Prompt Stage */}
          {stage === 'prompt' && (
            <motion.div
              key="prompt"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <motion.div
                className="w-16 h-16 rounded-3xl glass-card border border-primary/20 flex items-center justify-center"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <Smartphone size={28} className="text-primary" />
              </motion.div>

              <div className="text-center">
                <h3 className="text-lg font-bold text-foreground mb-1">Biometric Auth Required</h3>
                <p className="text-sm text-muted-foreground">
                  Use Face ID, Touch ID, or biometric to verify this {transactionType}
                </p>
              </div>

              <motion.button
                onClick={onAuthenticate}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.95 }}
                className="w-full py-3.5 rounded-2xl gradient-green text-black font-semibold flex items-center justify-center gap-2"
              >
                <Fingerprint size={16} />
                Authenticate
              </motion.button>

              <motion.button
                onClick={onFallback}
                whileHover={{ scale: 1.01 }}
                className="w-full py-3 rounded-2xl glass-card border border-white/5 text-muted-foreground text-sm font-medium hover:text-foreground transition-colors"
              >
                Use PIN Instead
              </motion.button>
            </motion.div>
          )}

          {/* Authenticating Stage */}
          {stage === 'authenticating' && (
            <motion.div
              key="auth"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <motion.div
                className="w-16 h-16 rounded-3xl glass-card border border-primary/20 flex items-center justify-center"
                animate={{ scale: 1.1 }}
                transition={{ duration: 0.3 }}
              >
                <Loader2 size={28} className="text-primary animate-spin" />
              </motion.div>

              <div className="text-center">
                <h3 className="text-lg font-bold text-foreground mb-1">Verifying Identity</h3>
                <p className="text-sm text-muted-foreground">
                  Place your finger on the sensor or look at the camera
                </p>
              </div>

              {/* Animated shield pulse */}
              <motion.div
                className="w-12 h-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center"
                animate={{
                  scale: [1, 1.3, 1],
                  opacity: [0.5, 0.1, 0.5],
                }}
                transition={{ duration: 2, repeat: Infinity }}
              >
                <Lock size={20} className="text-primary" />
              </motion.div>
            </motion.div>
          )}

          {/* Success Stage */}
          {stage === 'success' && (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', damping: 10, stiffness: 200 }}
                className="w-16 h-16 rounded-3xl gradient-green flex items-center justify-center"
              >
                <CheckCircle2 size={28} className="text-black" />
              </motion.div>

              <div className="text-center">
                <h3 className="text-lg font-bold text-foreground">Verified</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Biometric authentication successful
                </p>
              </div>
            </motion.div>
          )}

          {/* Error Stage */}
          {stage === 'error' && (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <motion.div
                className="w-16 h-16 rounded-3xl bg-red-400/15 border border-red-400/20 flex items-center justify-center"
                animate={{ shake: true }}
                transition={{ duration: 0.3, repeat: 2 }}
              >
                <AlertCircle size={28} className="text-red-400" />
              </motion.div>

              <div className="text-center">
                <h3 className="text-lg font-bold text-foreground">Authentication Failed</h3>
                <p className="text-sm text-muted-foreground mt-1">{error || 'Unable to verify identity'}</p>
                {retryCount < 2 && (
                  <p className="text-xs text-amber-400 mt-2">
                    Attempt {retryCount + 1} of 3
                  </p>
                )}
              </div>

              {retryCount < 2 ? (
                <motion.button
                  onClick={onRetry}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.95 }}
                  className="w-full py-3.5 rounded-2xl glass-card border border-white/10 text-foreground font-semibold hover:border-white/20 transition-all"
                >
                  Try Again
                </motion.button>
              ) : null}

              <motion.button
                onClick={onFallback}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.95 }}
                className="w-full py-3 rounded-2xl gradient-green text-black font-semibold"
              >
                Use PIN Instead
              </motion.button>
            </motion.div>
          )}

          {/* Fallback Stage (after 3 failures) */}
          {stage === 'fallback' && (
            <motion.div
              key="fallback"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="w-16 h-16 rounded-3xl bg-amber-400/15 border border-amber-400/20 flex items-center justify-center">
                <AlertCircle size={28} className="text-amber-400" />
              </div>

              <div className="text-center">
                <h3 className="text-lg font-bold text-foreground">Too Many Attempts</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Please use your PIN to continue
                </p>
              </div>

              <motion.button
                onClick={onFallback}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.95 }}
                className="w-full py-3.5 rounded-2xl gradient-green text-black font-semibold"
              >
                Enter PIN
              </motion.button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}
