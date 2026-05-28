import { useState, useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

export default function OTPEntry({ phone, onSubmit, loading, error, onResend }) {
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [resendCountdown, setResendCountdown] = useState(60);
  const [canResend, setCanResend] = useState(false);
  const inputRefs = useRef([]);

  // Countdown timer for resend
  useEffect(() => {
    if (resendCountdown <= 0) {
      setCanResend(true);
      return;
    }

    const timer = setInterval(() => {
      setResendCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [resendCountdown]);

  const handleInputChange = (index, value) => {
    // Only allow digits
    if (!/^\d?$/.test(value)) return;

    const newOtp = [...otp];
    newOtp[index] = value;
    setOtp(newOtp);

    // Auto-advance to next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index, e) => {
    if (e.key === 'Backspace' && !otp[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const otpString = otp.join('');
    if (otpString.length === 6) {
      onSubmit(otpString);
    }
  };

  const handleResend = () => {
    setOtp(['', '', '', '', '', '']);
    setResendCountdown(60);
    setCanResend(false);
    onResend();
    inputRefs.current[0]?.focus();
  };

  // Format phone for display
  const displayPhone = '+254' + phone.replace(/[^\d]/g, '').slice(-9);

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Heading */}
      <div className="text-center space-y-2">
        <h1 className="text-white text-2xl font-bold font-grotesk">
          Enter verification code
        </h1>
        <p className="text-white/60 text-sm">
          Sent to <span className="text-white font-medium">{displayPhone}</span>
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* OTP Input Boxes */}
      <div className="flex gap-3 justify-center">
        {otp.map((digit, index) => (
          <input
            key={index}
            ref={(el) => {
              inputRefs.current[index] = el;
            }}
            type="text"
            inputMode="numeric"
            value={digit}
            onChange={(e) => handleInputChange(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            maxLength="1"
            disabled={loading}
            className="w-12 h-12 text-center text-white text-lg font-bold bg-white/5 border border-white/20 rounded-lg focus:border-[#00C853] focus:outline-none transition-colors disabled:opacity-50"
          />
        ))}
      </div>

      {/* Verify Button */}
      <button
        type="submit"
        disabled={loading || otp.join('').length < 6}
        className="w-full bg-[#00C853] text-black font-bold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#00B84D] active:scale-95"
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin" />
            Verifying...
          </div>
        ) : (
          'Verify'
        )}
      </button>

      {/* Resend Link */}
      <div className="text-center">
        {canResend ? (
          <button
            type="button"
            onClick={handleResend}
            className="text-[#00C853] text-sm font-medium hover:text-[#00B84D] transition-colors"
          >
            Resend code
          </button>
        ) : (
          <p className="text-white/40 text-sm">
            Resend code in <span className="text-[#00C853] font-medium">{resendCountdown}s</span>
          </p>
        )}
      </div>
    </form>
  );
}