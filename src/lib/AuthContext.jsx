/**
 * Zuri Connect Africa — Auth Context v4 (Boot-Safe)
 *
 * CRITICAL FIXES:
 * 1. Auth initialization NEVER blocks app rendering past authChecked
 * 2. All startup async flows bounded by BOOT_TIMEOUT_MS (10s)
 * 3. authChecked is ALWAYS set in finally + failsafe
 * 4. Biometric / post-auth security init deferred via setTimeout (non-blocking)
 * 5. Recoverable failures fail-open (no permanent authError that bricks UI)
 */

import React, { createContext, useState, useContext, useEffect, useCallback, useRef } from 'react';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { mapSessionUser } from '@/lib/auth/authSession.js';
import { clearLocalDemoPhoneSession, getLocalDemoPhoneUser } from '@/lib/auth/phoneOtpSession.js';
import {
  startInactivityWatcher,
  stopInactivityWatcher,
  clearSession,
  secureWipe,
  validateSession,
  createSession,
  markSessionAuthenticated,
} from '@/lib/sessionSecurity';
import { bindSession } from '@/lib/deviceTrust';
import { startSimSwapMonitor, stopSimSwapMonitor } from '@/lib/simSwapDetector';
import { computeAtoRisk } from '@/lib/atoDefense';
import { audit } from '@/lib/auditLogger';
import { METRICS, track } from '@/lib/observability/metrics.js';
import { bootInfo, bootWarn } from '@/lib/devLog.js';

const AuthContext = createContext();

const BOOT_TIMEOUT_MS = 10_000;
const AUTH_SIGNOUT_TIMEOUT_MS = 8000;
const ATO_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const POST_AUTH_DEFER_MS = 100;

async function signOutWithTimeout(supabase, scope) {
  await Promise.race([
    supabase.auth.signOut({ scope }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('signOut_timeout')), AUTH_SIGNOUT_TIMEOUT_MS)
    ),
  ]).catch(() => {});
}

function withBootTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label}_timeout`)), BOOT_TIMEOUT_MS)
    ),
  ]);
}

function startAuthenticatedSession(currentUser) {
  createSession();
  markSessionAuthenticated();
  return currentUser;
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [appPublicSettings, setAppPublicSettings] = useState(null);

  const atoTimerRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const safeSet = useCallback((setter) => {
    if (mountedRef.current) setter();
  }, []);

  const logout = useCallback(async (shouldRedirect = true) => {
    try {
      stopInactivityWatcher();
      stopSimSwapMonitor();
      clearInterval(atoTimerRef.current);
      audit.logout('user_initiated', user?.email || 'unknown');
      secureWipe();
      const supabase = getSupabaseBrowserClient();
      await signOutWithTimeout(supabase, 'global');
    } catch (e) {
      console.warn('[logout] Cleanup error:', e?.message);
    }

    safeSet(() => {
      setUser(null);
      setIsAuthenticated(false);
    });

    if (shouldRedirect) {
      window.location.href = '/auth';
    }
  }, [user?.email, safeSet]);

  const silentLogout = useCallback(async (reason = 'security') => {
    try {
      stopInactivityWatcher();
      stopSimSwapMonitor();
      clearInterval(atoTimerRef.current);
      audit.logout(reason, user?.email || 'unknown');
      secureWipe();
      const supabase = getSupabaseBrowserClient();
      await signOutWithTimeout(supabase, 'local');
    } catch (e) {
      console.warn('[silentLogout] Cleanup error:', e?.message);
    }

    safeSet(() => {
      setUser(null);
      setIsAuthenticated(false);
      setAuthError({ type: 'auth_required', message: 'Re-authentication required' });
    });
  }, [user?.email, safeSet]);

  const navigateToLogin = useCallback(() => {
    window.location.href = '/auth';
  }, []);

  const startAtoMonitor = useCallback((email) => {
    clearInterval(atoTimerRef.current);
    atoTimerRef.current = setInterval(() => {
      try {
        const ato = computeAtoRisk();
        if (ato.requireLogout) {
          audit.atoSignal('critical_risk_auto_logout', ato.factors.join('; '), email);
          silentLogout('ato_critical_risk');
        }
      } catch (e) {
        console.warn('[ATO] Error:', e?.message);
      }
    }, ATO_CHECK_INTERVAL_MS);
  }, [silentLogout]);

  const safeStartSimSwapMonitor = useCallback((email) => {
    try {
      const timeoutHandle = setTimeout(() => {
        console.warn('[AuthContext] SIM-swap timeout');
        stopSimSwapMonitor();
      }, 5000);

      startSimSwapMonitor((result) => {
        clearTimeout(timeoutHandle);
        audit.riskEscalation(result.level, result.score, result.signals.map(s => s.code), email);
        if (result.level === 'CRITICAL') {
          silentLogout('sim_swap_critical');
        }
      });
    } catch (e) {
      console.warn('[simSwap] Startup failed:', e?.message);
    }
  }, [silentLogout]);

  const safeBindSession = useCallback(() => {
    try {
      bindSession();
    } catch (e) {
      console.warn('[bindSession] Failed:', e?.message);
    }
  }, []);

  const schedulePostAuthSecurity = useCallback((currentUser) => {
    setTimeout(() => {
      if (!mountedRef.current) return;
      try {
        bootInfo('[Zuri:Boot] post-auth security init (deferred, non-blocking)');
        safeBindSession();
        safeStartSimSwapMonitor(currentUser.email);
        startAtoMonitor(currentUser.email);
        bootInfo('[Zuri:Boot] post-auth security init completed');
      } catch (e) {
        console.warn('[postRender] Security init failed:', e?.message);
      }
    }, POST_AUTH_DEFER_MS);
  }, [safeBindSession, safeStartSimSwapMonitor, startAtoMonitor, safeSet]);

  const checkUserAuth = useCallback(async () => {
    bootInfo('[Zuri:Boot] checkUserAuth start');
    try {
      safeSet(() => setIsLoadingAuth(true));
      const supabase = getSupabaseBrowserClient();

      const { data: { session }, error } = await withBootTimeout(
        supabase.auth.getSession(),
        'getSession_checkUserAuth'
      );

      if (error) throw error;

      if (!session?.user) {
        const demoUser = getLocalDemoPhoneUser();
        if (demoUser) {
          startAuthenticatedSession(demoUser);
          safeSet(() => {
            setUser(demoUser);
            setIsAuthenticated(true);
          });
          audit.authSuccess('local_demo_phone_otp', demoUser.email);
          bootInfo('[Zuri:Boot] checkUserAuth end - local phone session');
          return;
        }
        clearLocalDemoPhoneSession();
        safeSet(() => {
          setIsAuthenticated(false);
          setUser(null);
        });
        bootInfo('[Zuri:Boot] checkUserAuth end - no session');
        return;
      }

      const currentUser = mapSessionUser(session.user);
      clearLocalDemoPhoneSession();
      startAuthenticatedSession(currentUser);
      safeSet(() => {
        setUser(currentUser);
        setIsAuthenticated(true);
      });
      audit.authSuccess('supabase_session', currentUser.email);
      schedulePostAuthSecurity(currentUser);
      bootInfo('[Zuri:Boot] checkUserAuth end - session restored');
    } catch (error) {
      console.warn('[checkUserAuth] Failed:', error?.message);
      try {
        track(METRICS.SUPABASE_SESSION_FAILURE, 1, { phase: 'checkUserAuth', message: error?.message || 'unknown' });
      } catch { /* ignore */ }
      safeSet(() => {
        setIsAuthenticated(false);
        setUser(null);
      });
    } finally {
      safeSet(() => setIsLoadingAuth(false));
      bootInfo('[Zuri:Boot] checkUserAuth finally');
    }
  }, [safeSet, schedulePostAuthSecurity]);

  const checkAppState = useCallback(async () => {
    bootInfo('[Zuri:Boot] checkAppState start');
    try {
      safeSet(() => {
        setIsLoadingPublicSettings(true);
        setAuthError(null);
      });

      const supabase = getSupabaseBrowserClient();
      const { data: { session }, error } = await withBootTimeout(
        supabase.auth.getSession(),
        'getSession_checkAppState'
      );

      if (error) throw error;

      safeSet(() => {
        setAppPublicSettings({ source: 'supabase', loadedAt: new Date().toISOString() });
      });

      if (session?.user) {
        await checkUserAuth();
      } else {
        const demoUser = getLocalDemoPhoneUser();
        if (demoUser) {
          startAuthenticatedSession(demoUser);
          safeSet(() => {
            setUser(demoUser);
            setIsAuthenticated(true);
          });
          audit.authSuccess('local_demo_phone_otp', demoUser.email);
          bootInfo('[Zuri:Boot] checkAppState local phone session');
        } else {
          clearLocalDemoPhoneSession();
          safeSet(() => {
            setIsAuthenticated(false);
            setUser(null);
          });
        }
      }
      bootInfo('[Zuri:Boot] checkAppState success path complete');
    } catch (error) {
      console.warn('[checkAppState] Error:', error?.message);
      try {
        track(METRICS.SUPABASE_SESSION_FAILURE, 1, {
          phase: 'checkAppState',
          timeout: Boolean(String(error?.message || '').includes('timeout')),
          message: error?.message || 'unknown',
        });
      } catch { /* ignore */ }
      safeSet(() => {
        setIsAuthenticated(false);
        setUser(null);
        setAuthError(null);
      });
    } finally {
      safeSet(() => {
        setIsLoadingPublicSettings(false);
        setIsLoadingAuth(false);
        setAuthChecked(true);
      });
      bootInfo('[Zuri:Boot] checkAppState finally - authChecked=true');
    }
  }, [checkUserAuth, safeSet]);

  useEffect(() => {
    bootInfo('[Zuri:Boot] AuthProvider mount');

    const supabase = getSupabaseBrowserClient();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      bootInfo('[Zuri:Boot] onAuthStateChange', event);
      if (session?.user) {
        clearLocalDemoPhoneSession();
        startAuthenticatedSession(mapSessionUser(session.user));
        safeSet(() => {
          setUser(mapSessionUser(session.user));
          setIsAuthenticated(true);
        });
      } else {
        const demoUser = getLocalDemoPhoneUser();
        if (demoUser) {
          startAuthenticatedSession(demoUser);
          safeSet(() => {
            setUser(demoUser);
            setIsAuthenticated(true);
          });
        } else {
          clearLocalDemoPhoneSession();
          safeSet(() => {
            setUser(null);
            setIsAuthenticated(false);
          });
        }
      }
      safeSet(() => setAuthChecked(true));
    });

    checkAppState().catch((e) => {
      bootWarn('[Zuri:Boot] checkAppState rejected', e?.message);
      safeSet(() => {
        setAuthChecked(true);
        setIsLoadingAuth(false);
        setIsLoadingPublicSettings(false);
        setIsAuthenticated(false);
        setUser(null);
        setAuthError(null);
      });
    });

    const onLocalDemoPhoneAuth = () => {
      const demoUser = getLocalDemoPhoneUser();
      if (!demoUser) return;
      startAuthenticatedSession(demoUser);
      safeSet(() => {
        setUser(demoUser);
        setIsAuthenticated(true);
        setAuthChecked(true);
        setIsLoadingAuth(false);
        setIsLoadingPublicSettings(false);
      });
      audit.authSuccess('local_demo_phone_otp', demoUser.email);
    };
    window.addEventListener('zuri:local-demo-phone-auth', onLocalDemoPhoneAuth);

    const bootFailsafe = setTimeout(() => {
      bootWarn('[Zuri:Boot] boot failsafe firing (10s) - forcing authChecked');
      safeSet(() => {
        setAuthChecked(true);
        setIsLoadingAuth(false);
        setIsLoadingPublicSettings(false);
      });
    }, BOOT_TIMEOUT_MS);

    return () => {
      clearTimeout(bootFailsafe);
      window.removeEventListener('zuri:local-demo-phone-auth', onLocalDemoPhoneAuth);
      subscription.unsubscribe();
      stopInactivityWatcher();
      stopSimSwapMonitor();
      clearInterval(atoTimerRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isAuthenticated) return;

    const handler = () => {
      if (document.visibilityState === 'visible') {
        const { valid, reason } = validateSession();
        if (!valid && reason !== 'no_session') {
          audit.sessionExpire(reason, user?.email);
          silentLogout(`session_invalid_${reason}`);
        }
      }
    };

    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [isAuthenticated, user?.email, silentLogout]);

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      logout,
      silentLogout,
      navigateToLogin,
      checkUserAuth,
      checkAppState,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be within AuthProvider');
  return context;
};
