import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import HesabuLogo from '@/components/brand/HesabuLogo';

export default function PhoneEntry({ onSubmit, loading, error }) {
  const [phone, setPhone] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (phone.trim()) {
      onSubmit(phone);
    }
  };

  const handlePhoneChange = (e) => {
    const value = e.target.value.replace(/[^\d+\s]/g, '');
    setPhone(value);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Brand */}
      <div className="hesabu-theme flex justify-center mb-8">
        <HesabuLogo size={96} showWordmark tagline />
      </div>

      {/* Heading */}
      <div className="text-center space-y-2">
        <h1 className="text-white text-2xl font-bold font-grotesk">
          Enter your M-PESA number
        </h1>
        <p className="text-white/60 text-sm">
          We'll send you a verification code
        </p>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {/* Phone Input */}
      <div className="space-y-2">
        <label htmlFor="phone-number" className="block text-white/80 text-sm font-medium">
          Phone Number
        </label>
        <div className="flex items-center bg-white/5 border border-white/10 rounded-xl px-4 py-3 focus-within:border-[#00C853]/50 transition-colors">
          <input
            id="phone-number"
            type="tel"
            value={phone}
            onChange={handlePhoneChange}
            placeholder="0712 345 678 or 0143 305 099"
            className="w-full bg-transparent text-white placeholder:text-white/40 outline-none text-sm"
            maxLength={18}
            disabled={loading}
            autoComplete="tel"
          />
        </div>
        <p className="text-white/40 text-xs">
          Enter your Kenyan mobile number starting with 07 or 01.
        </p>
      </div>

      {/* Send Button */}
      <button
        type="submit"
        disabled={loading || !phone.trim()}
        className="w-full bg-[#00C853] text-black font-bold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#00B84D] active:scale-95"
      >
        {loading ? (
          <div className="flex items-center justify-center gap-2">
            <Loader2 size={16} className="animate-spin" />
            Sending...
          </div>
        ) : (
          'Send Code'
        )}
      </button>

      {/* Footer text */}
      <p className="text-center text-white/40 text-xs">
        We send OTP via SMS. Standard rates apply.
      </p>
    </form>
  );
}
