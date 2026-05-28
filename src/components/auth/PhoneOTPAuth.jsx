import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft } from 'lucide-react';
import { invokeEdgeFunction } from '@/api/client.js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import {
  completeCustomPhoneOtpVerification,
  KENYAN_PHONE_ERROR,
  mapOtpSendErrorToCopy,
  normalizePhoneForSupabase,
  requestSupabasePhoneOtp,
  verifySupabasePhoneOtp,
} from '@/lib/auth/phoneOtpSession.js';
import PhoneEntry from './PhoneEntry';
import OTPEntry from './OTPEntry';

export default function PhoneOTPAuth({ onPhoneVerified, embedded }) {
  const navigate = useNavigate();
  const [screen, setScreen] = useState('phone'); // 'phone' or 'otp'
  const [phone, setPhone] = useState('');
  const [otpProvider, setOtpProvider] = useState('supabase');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handlePhoneSubmit = async (phoneNumber) => {
    if (!phoneNumber) return;
    setLoading(true);
    setError('');

    try {
      const normalizedPhone = normalizePhoneForSupabase(phoneNumber);
      const supabase = getSupabaseBrowserClient();
      try {
        await requestSupabasePhoneOtp(supabase, normalizedPhone);
        setOtpProvider('supabase');
        setPhone(normalizedPhone);
        setScreen('otp');
        return;
      } catch {
        // Fall through to the legacy custom OTP sender. Verification still
        // requires a Supabase session unless explicit local demo mode is on.
      }

      const data = await invokeEdgeFunction('sendOTP', { phone: normalizedPhone });
      if (!data?.success) {
        if (data?.error === 'INVALID_PHONE') {
          setError(KENYAN_PHONE_ERROR);
          return;
        }
        // The server may legally return 200 with success:false for soft
        // failures; map the same way we map thrown ApiErrors so rate_limited
        // payloads include the retry window.
        const publicError = mapOtpSendErrorToCopy(data);
        setError(publicError || 'Failed to send OTP. Please try again.');
        return;
      }

      setOtpProvider('custom');
      setPhone(normalizedPhone);
      setScreen('otp');
    } catch (err) {
      if (err?.code === 'INVALID_KENYAN_PHONE') {
        setError(KENYAN_PHONE_ERROR);
      } else {
        const publicError = mapOtpSendErrorToCopy(err);
        if (publicError) {
          setError(publicError);
        } else {
          setError('Failed to send OTP. Please check your connection and try again.');
          console.error('sendOTP error:', err?.message || err);
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleOTPSubmit = async (otp) => {
    if (!otp || otp.length < 4) {
      setError('Please enter a valid code');
      return;
    }
    setLoading(true);
    setError('');

    try {
      const supabase = getSupabaseBrowserClient();

      if (otpProvider === 'supabase') {
        await verifySupabasePhoneOtp(supabase, phone, otp);
        if (onPhoneVerified) onPhoneVerified();
        navigate('/');
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      const accessToken = session?.access_token ?? null;
      const data = await invokeEdgeFunction('verifyOTP', { phone, otp }, accessToken);
      if (data?.success) {
        await completeCustomPhoneOtpVerification(supabase, phone);
        if (onPhoneVerified) onPhoneVerified();
        navigate('/');
      } else {
        if (data?.locked) {
          setError('Too many attempts. Try again in 30 minutes.');
        } else if (data?.attemptsRemaining !== undefined) {
          setError(
            `Incorrect code. ${data.attemptsRemaining} attempt${
              data.attemptsRemaining === 1 ? '' : 's'
            } remaining.`
          );
        } else {
          setError(data?.error || 'Verification failed. Please try again.');
        }
      }
    } catch (err) {
      if (err?.code === 'PHONE_OTP_SESSION_REQUIRED') {
        setError('PHONE_OTP_SESSION_REQUIRED');
      } else {
        setError('Verification failed. Check your connection and try again.');
      }
      console.error('verifyOTP error:', err?.message || err);
    } finally {
      setLoading(false);
    }
  };

  const outerClass = embedded
    ? 'relative flex min-h-full w-full items-center justify-center bg-black'
    : 'fixed inset-0 bg-black flex items-center justify-center';

  return (
    <div className={outerClass}>
      <div className="w-full max-w-md px-6 py-8">
        <AnimatePresence mode="wait">
          {screen === 'phone' ? (
            <motion.div
              key="phone"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              <PhoneEntry
                onSubmit={handlePhoneSubmit}
                loading={loading}
                error={error}
              />
            </motion.div>
          ) : (
            <motion.div
              key="otp"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              <button
                onClick={() => setScreen('phone')}
                className="flex items-center gap-2 text-white/60 hover:text-white mb-6 transition-colors"
              >
                <ArrowLeft size={18} />
                <span className="text-sm">Back</span>
              </button>
              <OTPEntry
                phone={phone}
                onSubmit={handleOTPSubmit}
                loading={loading}
                error={error}
                onResend={() => handlePhoneSubmit(phone)}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
