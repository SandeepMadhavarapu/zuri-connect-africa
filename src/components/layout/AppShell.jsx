import { useState, useEffect, useRef, Component } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import BottomNav from './BottomNav';
import NetworkBanner from './NetworkBanner';
import TopBar from './TopBar';
import { useSessionSecurity } from '@/hooks/useSessionSecurity';
import { useAuth } from '@/lib/AuthContext';
import PinPad from '@/components/security/PinPad';
import RouteGuard from '@/components/security/RouteGuard';
import OfflineQueueIndicator from '@/components/network/OfflineQueueIndicator';
import { Clock, ShieldAlert, RotateCcw } from 'lucide-react';
import { bootInfo, devInfo } from '@/lib/devLog.js';

export const SHELL_MAX_WIDTH = 452;

class ContentBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    console.error('[ContentBoundary]', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center px-4 py-16 min-h-[200px]">
          <div className="text-center space-y-4">
            <ShieldAlert size={32} className="text-red-500 mx-auto" />
            <div>
              <p className="text-sm font-semibold text-foreground mb-1">Page Content Failed</p>
              <p className="text-xs text-muted-foreground mb-4">The page encountered an error loading</p>
            </div>
            <button
              onClick={() => this.setState({ hasError: false })}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary"
            >
              <RotateCcw size={12} /> Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const pageVariants = {
  initial:  { opacity: 0.88, y: 4 },
  animate:  { opacity: 1, y: 0 },
  exit:     { opacity: 0.88, y: -4 },
};
const pageTransition = { duration: 0.14, ease: 'easeOut' };

export default function AppShell() {
  const location  = useLocation();
  const prevPath  = useRef(location.pathname);
  const hideNav   = ['/onboarding', '/pin', '/biometric'].includes(location.pathname);
  const isChamaRoute = location.pathname.startsWith('/chama');
  const { user }  = useAuth();
  const { isLocked, showWarning, unlock, dismissWarning } = useSessionSecurity(user?.email || 'anonymous');
  const [warningCountdown, setWarningCountdown] = useState(60);

  useEffect(() => {
    bootInfo('[Zuri:Boot] AppShell mounted');
  }, []);

  useEffect(() => {
    if (prevPath.current !== location.pathname) {
      if (import.meta.env.DEV) {
        devInfo('[Shell] route:', prevPath.current, '->', location.pathname);
      }
      bootInfo('[Zuri:Boot] route hydration', prevPath.current, '->', location.pathname);
      prevPath.current = location.pathname;
    }
  }, [location.pathname]);

  useEffect(() => {
    if (!showWarning) { setWarningCountdown(60); return; }
    setWarningCountdown(60);
    const t = setInterval(() => setWarningCountdown(c => (c <= 1 ? 0 : c - 1)), 1000);
    return () => clearInterval(t);
  }, [showWarning]);

  return (
    <div className="zuri-app-viewport">
      <div
        className="zuri-app-frame"
        style={{ maxWidth: SHELL_MAX_WIDTH }}
      >
        {/* Ambient background */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full bg-primary/3 blur-3xl" />
          <div className="absolute bottom-32 right-0 w-48 h-48 rounded-full bg-primary/2 blur-3xl" />
        </div>

        {/* Top chrome */}
        <div
          className="relative z-10 shrink-0"
          style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}
        >
          <NetworkBanner />
          {!hideNav && <TopBar />}
        </div>

        {/* Scroll container */}
        <main
          className="app-scrollbar flex-1 overflow-y-auto overflow-x-hidden relative z-10 min-h-0"
          data-chama-route={isChamaRoute ? '' : undefined}
        >
          <ContentBoundary key={location.pathname}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                transition={pageTransition}
                style={{ paddingBottom: 'max(96px, calc(66px + env(safe-area-inset-bottom, 0px) + 24px))' }}
              >
                <RouteGuard>
                  <Outlet />
                </RouteGuard>
              </motion.div>
            </AnimatePresence>
          </ContentBoundary>
        </main>

        {/* Bottom nav */}
        <div className="relative z-10 shrink-0">
          {!hideNav && <BottomNav />}
        </div>

        {/* Offline queue */}
        <OfflineQueueIndicator />

        {/* Inactivity warning */}
        <AnimatePresence>
          {showWarning && !isLocked && (
            <motion.div
              initial={{ y: -80, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -80, opacity: 0 }}
              className="absolute top-0 left-0 right-0 z-40 px-4 pt-3 pb-2"
            >
              <div className="glass-card rounded-2xl px-4 py-3 flex items-center gap-3 border border-amber-400/20">
                <Clock size={14} className="text-amber-400 shrink-0" />
                <div className="flex-1">
                  <p className="text-xs font-semibold text-amber-400">Session expiring in {warningCountdown}s</p>
                  <p className="text-[10px] text-muted-foreground">Tap to stay signed in</p>
                </div>
                <button
                  onClick={dismissWarning}
                  className="text-[11px] text-primary font-semibold px-3 py-1.5 rounded-xl bg-primary/10 border border-primary/20"
                >
                  Stay
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Session lock overlay */}
        <AnimatePresence>
          {isLocked && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 glass flex flex-col items-center justify-center px-6"
            >
              <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
                <ShieldAlert size={24} className="text-primary" />
              </div>
              <p className="text-base font-bold text-foreground font-grotesk mb-1">Session Locked</p>
              <p className="text-[12px] text-muted-foreground text-center mb-6">
                Your session expired due to inactivity. Re-enter your PIN to continue.
              </p>
              <div className="w-full max-w-[300px]">
                <PinPad mode="verify" onSuccess={unlock} onFailure={() => {}} onForgot={() => {}} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
