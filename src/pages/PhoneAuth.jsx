import { useState } from 'react';
import { motion } from 'framer-motion';
import PhoneOTPAuth from '@/components/auth/PhoneOTPAuth';
import EmailPasswordAuth from '@/components/auth/EmailPasswordAuth';

export default function PhoneAuth() {
  const [mode, setMode] = useState('phone');

  return (
    <div className="fixed inset-0 bg-black flex flex-col">
      <div className="flex justify-center gap-2 pt-8 pb-4 px-6 shrink-0 z-20">
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={() => setMode('phone')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
            mode === 'phone'
              ? 'bg-[#00C853] text-black'
              : 'bg-white/10 text-white/70 border border-white/10'
          }`}
        >
          Phone OTP
        </motion.button>
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={() => setMode('email')}
          className={`px-4 py-2 rounded-xl text-xs font-semibold transition-colors ${
            mode === 'email'
              ? 'bg-[#00C853] text-black'
              : 'bg-white/10 text-white/70 border border-white/10'
          }`}
        >
          Email
        </motion.button>
      </div>
      <div className="flex-1 relative min-h-0">
        {mode === 'phone' ? <PhoneOTPAuth embedded /> : <EmailPasswordAuth embedded />}
      </div>
    </div>
  );
}
