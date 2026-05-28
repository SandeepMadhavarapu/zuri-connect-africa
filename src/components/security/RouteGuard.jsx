/**
 * RouteGuard — Enforces route-level protection for all app routes.
 *
 * Behaviour:
 *   - 'auth'   routes: redirect to login if not authenticated
 *   - 'stepup' routes: show inline step-up auth sheet before rendering route
 *   - 'admin'  routes: verify admin role + step-up auth
 *
 * Step-up freshness: if the route has stepUpFreshMs > 0, a completed
 * step-up within that window is accepted without re-prompting.
 *
 * Session validation: validates session on every route render — stale or
 * device-mismatched sessions are immediately cleared and redirected.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ShieldAlert, Lock, AlertTriangle, ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/AuthContext';
import { getRouteProtection } from '@/lib/routeGuard';
import { getUserRole, ROLES } from '@/lib/rbac';
import { validateSession, rotateSession } from '@/lib/sessionSecurity';
import { audit } from '@/lib/auditLogger';
import { bootInfo, bootWarn } from '@/lib/devLog.js';
import PinPad from './PinPad';

const STEPUP_CACHE_KEY = 'zuri_stepup_cache';

function getStepUpCache() {
  try { return JSON.parse(sessionStorage.getItem(STEPUP_CACHE_KEY) || '{}'); } catch { return {}; }
}

function setStepUpCache(path) {
  const cache = getStepUpCache();
  cache[path] = Date.now();
  sessionStorage.setItem(STEPUP_CACHE_KEY, JSON.stringify(cache));
}

function isStepUpFresh(path, freshMs) {
  if (freshMs === 0) return false;
  const cache = getStepUpCache();
  const ts    = cache[path];
  if (!ts) return false;
  return (Date.now() - ts) < freshMs;
}

const ROUTE_GUARD_WATCHDOG_MS = 8000;

export default function RouteGuard({ children }) {
  const { user, isAuthenticated, logout, navigateToLogin } = useAuth();
  const location = useLocation();
  const pathname = location.pathname;

  const [state, setState] = useState('checking');
  const [guardConfig, setGuardConfig] = useState(null);
  const watchdogRef = useRef(null);
  const mountedRef = useRef(true);
  const sessionAllowedOnceRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeSetState = useCallback((next) => {
    if (!mountedRef.current) return;
    setState((prev) => (typeof next === 'function' ? next(prev) : next));
  }, []);

  const evaluate = useCallback(() => {
    try {
      const config = getRouteProtection(pathname);
      setGuardConfig(config);

      const sessionValid = validateSession();
      if (!sessionValid.valid && isAuthenticated) {
        // Only hard-fail on security violations, not on missing session.
        // 'no_session' during initial login is a race condition —
        // zuri_session_v3 is created by useSessionSecurity after this runs.
        // Give it one re-evaluation cycle before logging the user out.
        if (sessionValid.reason === 'no_session') {
          // Soft-fail: session key not yet written. Do not logout.
          // RouteGuard will re-evaluate when state changes.
          sessionAllowedOnceRef.current = true;
          safeSetState('allowed');
          return;
        }
        audit.sessionExpire(sessionValid.reason, user?.email);
        logout(false);
        navigateToLogin();
        safeSetState('denied');
        return;
      }

      if (!isAuthenticated) {
        sessionAllowedOnceRef.current = false;
        audit.routeAccess(pathname, false, 'anonymous');
        if (config.level !== 'public') {
          navigateToLogin();
          safeSetState('denied');
          return;
        }
        safeSetState('allowed');
        bootInfo('[Zuri:Boot] RouteGuard allowed (public, anonymous)', pathname);
        return;
      }

      if (config.level === 'admin') {
        const role = getUserRole(user);
        const allowedRoles = config.allowedRoles || [ROLES.ADMIN, ROLES.AUDITOR, ROLES.FRAUD_ANALYST];
        if (!allowedRoles.includes(role)) {
          audit.routeAccess(pathname, false, user?.email);
          safeSetState('admin_denied');
          return;
        }
        if (!isStepUpFresh(pathname, 0)) {
          audit.routeAccess(pathname, false, user?.email);
          safeSetState('stepup');
          return;
        }
      }

      if (config.level === 'stepup') {
        const freshMs = config.stepUpFreshMs ?? 0;
        if (!isStepUpFresh(pathname, freshMs)) {
          audit.routeAccess(pathname, false, user?.email);
          safeSetState('stepup');
          return;
        }
      }

      audit.routeAccess(pathname, true, user?.email);
      safeSetState('allowed');
      bootInfo('[Zuri:Boot] RouteGuard allowed', pathname);
    } catch (err) {
      if (import.meta.env.DEV) console.error('[RouteGuard]', err);
      try {
        const config = getRouteProtection(pathname);
        if (config.level === 'public') {
          setGuardConfig(config);
          safeSetState('allowed');
          bootInfo('[Zuri:Boot] RouteGuard recover -> public allowed', pathname);
        } else {
          navigateToLogin();
          safeSetState('denied');
        }
      } catch {
        navigateToLogin();
        safeSetState('denied');
      }
    }
  }, [pathname, isAuthenticated, user, logout, navigateToLogin, safeSetState]);

  useEffect(() => {
    // If we already allowed this authenticated session once,
    // do not reset to checking on re-evaluation.
    // This prevents the no_session race condition loop.
    if (sessionAllowedOnceRef.current && isAuthenticated) {
      safeSetState('allowed');
      return;
    }
    safeSetState('checking');
    evaluate();
  }, [evaluate, safeSetState, isAuthenticated]);

  useEffect(() => {
    if (state !== 'checking') {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      return undefined;
    }
    watchdogRef.current = setTimeout(() => {
      safeSetState((prev) => {
        if (prev !== 'checking') return prev;
        try {
          const config = getRouteProtection(pathname);
          if (config.level === 'public') {
            bootInfo('[Zuri:Boot] RouteGuard watchdog -> public allowed', pathname);
            return 'allowed';
          }
        } catch {
          /* fall through */
        }
        if (isAuthenticated) {
          return 'allowed';
        }
        bootWarn('[Zuri:Boot] RouteGuard watchdog -> denied, redirect login', pathname);
        navigateToLogin();
        return 'denied';
      });
    }, ROUTE_GUARD_WATCHDOG_MS);
    return () => {
      if (watchdogRef.current) clearTimeout(watchdogRef.current);
    };
  }, [state, pathname, isAuthenticated, navigateToLogin, safeSetState]);

  const handleStepUpSuccess = () => {
    rotateSession('route_stepup');
    setStepUpCache(pathname);
    audit.stepUpPassed(user?.email);
    safeSetState('allowed');
    bootInfo('[Zuri:Boot] RouteGuard step-up success', pathname);
  };

  const handleStepUpFailure = () => {
    audit.stepUpFailed(user?.email);
  };

  const handleStepUpCancel = () => {
    window.history.back();
  };

  if (state === 'checking') {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (state === 'admin_denied') {
    return <AccessDenied reason="This area requires administrator access." />;
  }

  if (state === 'stepup') {
    return (
      <StepUpGate
        reason={guardConfig?.reason || 'This area requires additional verification.'}
        onSuccess={handleStepUpSuccess}
        onFailure={handleStepUpFailure}
        onCancel={handleStepUpCancel}
        userId={user?.email}
      />
    );
  }

  if (state === 'denied') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[300px] px-6 text-center">
        <div className="w-14 h-14 rounded-2xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-4">
          <AlertTriangle size={22} className="text-amber-400" />
        </div>
        <h2 className="text-sm font-bold text-foreground font-grotesk mb-2">Redirecting...</h2>
        <p className="text-[12px] text-muted-foreground">Please wait</p>
      </div>
    );
  }

  return children;
}

function StepUpGate({ reason, onSuccess, onFailure, onCancel, userId }) {
  useEffect(() => {
    audit.stepUpIssued(reason, userId);
  }, [reason, userId]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 16 }}
        transition={{ duration: 0.28, ease: [0.34, 1.56, 0.64, 1] }}
        className="px-4 py-8 flex flex-col items-center"
      >
        <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
          <Lock size={22} className="text-primary" />
        </div>

        <h2 className="text-base font-bold text-foreground font-grotesk mb-1 text-center">
          Verification Required
        </h2>
        <p className="text-[12px] text-muted-foreground text-center mb-6 px-4 leading-relaxed">
          {reason}
        </p>

        <div className="w-full max-w-[320px]">
          <PinPad
            mode="verify"
            onSuccess={onSuccess}
            onFailure={onFailure}
            onForgot={() => {}}
          />
        </div>

        <button
          onClick={onCancel}
          className="mt-5 flex items-center gap-1.5 text-[12px] text-muted-foreground"
        >
          <ArrowLeft size={12} />
          Go back
        </button>
      </motion.div>
    </AnimatePresence>
  );
}

function AccessDenied({ reason }) {
  return (
    <div className="flex flex-col items-center justify-center min-h-[300px] px-6 text-center">
      <div className="w-14 h-14 rounded-2xl bg-red-400/10 border border-red-400/20 flex items-center justify-center mb-4">
        <ShieldAlert size={22} className="text-red-400" />
      </div>
      <h2 className="text-sm font-bold text-foreground font-grotesk mb-2">Access Denied</h2>
      <p className="text-[12px] text-muted-foreground leading-relaxed">{reason}</p>
      <button
        onClick={() => window.history.back()}
        className="mt-5 flex items-center gap-1.5 text-[12px] text-muted-foreground"
      >
        <ArrowLeft size={12} />
        Go back
      </button>
    </div>
  );
}
