import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Smartphone,
  Shield,
  CheckCircle2,
  AlertCircle,
  Loader2,
  X,
  Clock,
} from 'lucide-react';
import {
  BIOMETRIC_SESSION_REQUIRED_MESSAGE,
  isBiometricSupported,
  getPlatformAuthenticators,
  registerBiometric,
  clearBiometricEnrollment,
  isBiometricEnrolled,
  getBiometricEnrollmentInfo,
  formatBiometricEnrolledLabel,
} from '@/lib/biometricAuth';
import { useAuth } from '@/lib/AuthContext';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

function toUserBiometricError(error) {
  const message = String(error?.error || error?.message || error || '');
  if (
    error?.code === 'BIOMETRIC_SESSION_REQUIRED' ||
    /access token required|missing_authorization|invalid_token|session_required|session_unavailable/i.test(message)
  ) {
    return BIOMETRIC_SESSION_REQUIRED_MESSAGE;
  }
  if (/Biometric setup is not configured for this app origin/i.test(message)) {
    return message;
  }
  if (/webauthn_app_origin_missing|webauthn_rp_id_missing|webauthn_rp_id_origin_mismatch|webauthn_origin_insecure/i.test(message)) {
    return 'Biometric setup is not configured for this app origin.';
  }
  return message || 'Biometric enrollment failed';
}

function toConsoleBiometricError(error) {
  const message = String(error?.error || error?.message || error || 'unknown');
  if (/access token|required|authorization|token|session/i.test(message)) {
    return 'biometric_session_required';
  }
  return message;
}

export default function BiometricSecurityPanel() {
  const { user } = useAuth();
  const [supported, setSupported] = useState(false);
  const [hasAuthenticator, setHasAuthenticator] = useState(false);
  const [enrolled, setEnrolled] = useState(false);
  const [enrollmentInfo, setEnrollmentInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    const checkBiometric = async () => {
      try {
        const isSupported = isBiometricSupported();
        setSupported(isSupported);

        if (isSupported) {
          const hasAuth = await getPlatformAuthenticators();
          setHasAuthenticator(hasAuth);

          if (user?.email) {
            const isEnrolled = isBiometricEnrolled(user.email);
            setEnrolled(isEnrolled);

            if (isEnrolled) {
              const info = await getBiometricEnrollmentInfo(user.email);
              setEnrollmentInfo(info);
            }
          }
        }
      } catch (e) {
        console.error('[BiometricPanel] Check failed:', e);
        setError('Failed to check biometric support');
      } finally {
        setLoading(false);
      }
    };

    checkBiometric();
  }, [user]);

  const handleEnrollBiometric = async () => {
    if (!user?.email) return;

    setEnrolling(true);
    setError(null);
    setSuccess(null);

    try {
      const supabase = getSupabaseBrowserClient();
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) {
        throw new Error('session_unavailable');
      }
      const accessToken = data?.session?.access_token;
      if (!accessToken) {
        setError(BIOMETRIC_SESSION_REQUIRED_MESSAGE);
        return;
      }

      const result = await registerBiometric(user.email, user.full_name || 'User', accessToken);

      if (result.success) {
        setEnrolled(true);
        const info = await getBiometricEnrollmentInfo(user.email);
        setEnrollmentInfo(info);
        setSuccess('Biometric enrollment successful! Face ID / Biometrics is now enabled.');

        setTimeout(() => setSuccess(null), 5000);
      } else {
        setError(toUserBiometricError(result));
      }
    } catch (e) {
      console.error('[BiometricPanel] Enrollment error:', toConsoleBiometricError(e));
      setError(toUserBiometricError(e));
    } finally {
      setEnrolling(false);
    }
  };

  const handleRemoveBiometric = async () => {
    if (!user?.email) return;

    setRemoving(true);
    setError(null);
    setSuccess(null);

    try {
      const result = await clearBiometricEnrollment(user.email);

      if (result.success) {
        setEnrolled(false);
        setEnrollmentInfo(null);
        setSuccess('Biometric enrollment removed successfully.');

        setTimeout(() => setSuccess(null), 4000);
      } else {
        setError(result.error || 'Removal failed');
      }
    } catch (e) {
      console.error('[BiometricPanel] Removal error:', e);
      setError(e?.message || 'Biometric removal failed');
    } finally {
      setRemoving(false);
    }
  };

  if (loading) {
    return (
      <div className="hesabu-card rounded-2xl p-6">
        <div className="flex items-center justify-center py-8">
          <Loader2 size={18} className="text-hesabu-emerald animate-spin" />
        </div>
      </div>
    );
  }

  if (!supported) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="hesabu-card rounded-2xl p-5 border-hesabu-brass/25 bg-hesabu-brass/[0.06]"
      >
        <div className="flex items-start gap-4">
          <AlertCircle size={18} className="text-hesabu-brass shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-hesabu-brass mb-1">
              Biometric Not Supported
            </p>
            <p className="text-xs text-hesabu-muted leading-relaxed">
              Your device or browser does not support WebAuthn biometric authentication.
              Please use PIN or password authentication instead.
            </p>
          </div>
        </div>
      </motion.div>
    );
  }

  if (!hasAuthenticator) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="hesabu-card rounded-2xl p-5 border-hesabu-brass/25 bg-hesabu-brass/[0.06]"
      >
        <div className="flex items-start gap-4">
          <AlertCircle size={18} className="text-hesabu-brass shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-hesabu-brass mb-1">
              Authenticator Not Available
            </p>
            <p className="text-xs text-hesabu-muted leading-relaxed">
              Your device does not have a platform authenticator (Face ID, Touch ID, Windows Hello).
              Biometric authentication is not available.
            </p>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-4"
    >
      {/* Status card */}
      <div className={`hesabu-card rounded-[24px] p-5 transition-all ${
        enrolled
          ? 'border-hesabu-emerald/25 bg-hesabu-emerald/[0.06]'
          : ''
      }`}>
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-start gap-3 flex-1">
            <motion.div
              className="rounded-2xl p-3 shrink-0 bg-hesabu-surface-2 border border-hesabu-line"
              whileHover={{ scale: 1.05 }}
            >
              <Smartphone
                size={20}
                className={enrolled ? 'text-hesabu-emerald' : 'text-hesabu-muted'}
              />
            </motion.div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-hesabu-paper">
                Biometric Security
              </p>
              <p className="text-xs text-hesabu-muted mt-0.5">
                Face ID, Touch ID, or Windows Hello
              </p>
            </div>
          </div>
          {enrolled && (
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-hesabu-surface-2 border border-hesabu-line"
            >
              <CheckCircle2 size={12} className="text-hesabu-emerald" />
              <span className="text-xs font-semibold text-hesabu-emerald">Enabled</span>
            </motion.div>
          )}
        </div>

        {/* Enrollment info */}
        {enrolled && enrollmentInfo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="flex items-center gap-2 mb-4 p-2.5 rounded-lg bg-hesabu-surface-2 border border-hesabu-line"
          >
            <Clock size={13} className="text-hesabu-emerald shrink-0" />
            <span className="text-xs text-hesabu-emerald">
              {formatBiometricEnrolledLabel(enrollmentInfo?.enrolledAt)}
            </span>
          </motion.div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2">
          {!enrolled ? (
            <motion.button
              onClick={handleEnrollBiometric}
              disabled={enrolling}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.95 }}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-hesabu-emerald text-hesabu-ink text-sm font-bold hover:bg-hesabu-emerald-dim disabled:opacity-50 transition-all shadow-lg shadow-black/30"
            >
              {enrolling ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Enrolling...
                </>
              ) : (
                <>
                  <Shield size={14} />
                  Enable Biometric
                </>
              )}
            </motion.button>
          ) : (
            <motion.button
              onClick={handleRemoveBiometric}
              disabled={removing}
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.95 }}
              className="flex-1 inline-flex items-center justify-center gap-2.5 px-4 py-3 rounded-2xl border border-hesabu-danger/20 bg-hesabu-danger/[0.06] text-hesabu-danger text-sm font-semibold tracking-tight hover:border-hesabu-danger/40 hover:bg-hesabu-danger/[0.1] disabled:opacity-50 transition-all"
            >
              {removing ? (
                <>
                  <Loader2 size={14} className="animate-spin opacity-90" />
                  <span>Removing...</span>
                </>
              ) : (
                <>
                  <X size={14} strokeWidth={2.25} className="opacity-90" />
                  <span>Remove Biometric</span>
                </>
              )}
            </motion.button>
          )}
        </div>
      </div>

      {/* Error state */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="hesabu-card rounded-2xl p-4 border-hesabu-danger/25 bg-hesabu-danger/[0.06]"
          >
            <div className="flex items-start gap-3">
              <AlertCircle size={14} className="text-hesabu-danger shrink-0 mt-0.5" />
              <p className="text-xs text-hesabu-danger leading-relaxed font-medium">{String(error).replace(/^Error:\s*/i, '')}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Success state */}
      <AnimatePresence>
        {success && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="hesabu-card rounded-2xl p-4 border-hesabu-emerald/25 bg-hesabu-emerald/[0.06]"
          >
            <div className="flex items-start gap-3">
              <CheckCircle2 size={14} className="text-hesabu-emerald shrink-0 mt-0.5" />
              <p className="text-xs text-hesabu-emerald font-medium">{success}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info text */}
      <p className="text-xs text-hesabu-muted leading-relaxed px-2">
        When enabled, you'll use your device's biometric authentication (Face ID, Touch ID, fingerprint, or Windows Hello) for secure transactions. Your biometric data never leaves your device.
      </p>
    </motion.div>
  );
}
