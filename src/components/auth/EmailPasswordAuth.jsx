import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { login, register } from '@/api/auth.js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import HesabuLogo from '@/components/brand/HesabuLogo';

export default function EmailPasswordAuth({ embedded }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [isRegister, setIsRegister] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    if (!email.trim() || !password) {
      setError('Enter email and password.');
      return;
    }
    if (isRegister && !fullName.trim()) {
      setError('Enter your name to create an account.');
      return;
    }

    setLoading(true);
    try {
      if (isRegister) {
        await register(email.trim(), password, { fullName: fullName.trim() });
        const supabase = getSupabaseBrowserClient();
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          window.location.href = '/';
          return;
        }
        setInfo('Check your email to confirm your account, then sign in.');
      } else {
        await login(email.trim(), password);
        window.location.href = '/';
      }
    } catch (err) {
      setError(err?.message || 'Something went wrong.');
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
          <motion.div
            key={isRegister ? 'reg' : 'login'}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="hesabu-theme flex justify-center mb-8">
                <HesabuLogo size={96} showWordmark tagline />
              </div>

              <div className="text-center space-y-2">
                <h1 className="text-white text-2xl font-bold font-grotesk">
                  {isRegister ? 'Create your account' : 'Sign in with email'}
                </h1>
                <p className="text-white/60 text-sm">
                  {isRegister ? 'Use the same email you use for M-PESA alerts' : 'Secure session — encrypted in transit'}
                </p>
              </div>

              {error && (
                <div className="bg-red-400/10 border border-red-400/20 rounded-xl px-4 py-3">
                  <p className="text-red-400 text-sm">{error}</p>
                </div>
              )}

              {info && (
                <div className="bg-primary/10 border border-primary/20 rounded-xl px-4 py-3">
                  <p className="text-primary text-sm">{info}</p>
                </div>
              )}

              {isRegister && (
                <div className="space-y-2">
                  <label className="block text-white/80 text-sm font-medium">Full name</label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(ev) => setFullName(ev.target.value)}
                    autoComplete="name"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/40 outline-none text-sm focus:border-[#00C853]/50 transition-colors"
                    placeholder="e.g. Wanjiku Kamau"
                    disabled={loading}
                  />
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-white/80 text-sm font-medium">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(ev) => setEmail(ev.target.value)}
                  autoComplete="email"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/40 outline-none text-sm focus:border-[#00C853]/50 transition-colors"
                  placeholder="you@example.com"
                  disabled={loading}
                />
              </div>

              <div className="space-y-2">
                <label className="block text-white/80 text-sm font-medium">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(ev) => setPassword(ev.target.value)}
                  autoComplete={isRegister ? 'new-password' : 'current-password'}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder:text-white/40 outline-none text-sm focus:border-[#00C853]/50 transition-colors"
                  placeholder="••••••••"
                  disabled={loading}
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#00C853] text-black font-bold py-3 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[#00B84D] active:scale-95"
              >
                {loading ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    {isRegister ? 'Creating…' : 'Signing in…'}
                  </span>
                ) : (
                  (isRegister ? 'Create account' : 'Sign in')
                )}
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => {
                    setIsRegister(!isRegister);
                    setError('');
                    setInfo('');
                  }}
                  className="text-[#00C853] text-sm font-medium hover:underline"
                >
                  {isRegister ? 'Already have an account? Sign in' : 'New here? Create an account'}
                </button>
              </div>

              <p className="text-center text-white/40 text-xs">
                By continuing you agree to secure processing of your credentials via Supabase Auth.
              </p>
            </form>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
