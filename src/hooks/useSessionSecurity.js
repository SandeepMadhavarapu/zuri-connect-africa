/**
 * useSessionSecurity — AppShell integration hook
 *
 * Connects the session security manager to the React component tree.
 * Provides:
 *   isLocked       — true when inactivity lock is active
 *   showWarning    — true when 60s warning banner is showing
 *   unlock(reason) — call after successful re-auth to clear the lock
 *   dismissWarning — dismiss warning, resets sliding timer
 *   sessionAge     — seconds since session creation (for UI display)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  startInactivityWatcher,
  stopInactivityWatcher,
  createSession,
  markSessionAuthenticated,
  clearSession,
  getSession,
  rotateSession,
  validateSession,
} from '@/lib/sessionSecurity';
import { audit } from '@/lib/auditLogger';

export function useSessionSecurity(userId = 'anonymous') {
  const [isLocked,    setIsLocked]    = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const [sessionAge,  setSessionAge]  = useState(0);
  const cleanupRef   = useRef(null);
  const ageTimerRef  = useRef(null);

  // ── Session age counter (ticks every 30s for UI display) ────────────────
  useEffect(() => {
    ageTimerRef.current = setInterval(() => {
      const session = getSession();
      if (session?.createdAt) {
        setSessionAge(Math.floor((Date.now() - session.createdAt) / 1000));
      }
    }, 30_000);
    return () => clearInterval(ageTimerRef.current);
  }, []);

  // ── Inactivity watcher ──────────────────────────────────────────────────
  useEffect(() => {
    const session = createSession();
    markSessionAuthenticated();
    audit.sessionCreate(session.id, userId);

    const cleanup = startInactivityWatcher(
      // onLock — inactivity timeout or hard cap hit
      () => {
        const { reason } = validateSession();
        audit.sessionExpire(reason || 'inactivity', userId);
        setShowWarning(false);
        setIsLocked(true);
      },
      // onWarn — 60s before lock
      () => {
        setShowWarning(true);
      },
    );

    cleanupRef.current = cleanup;

    return () => {
      cleanup?.();
      stopInactivityWatcher();
    };
  }, [userId]);

  // ── Unlock: called after successful re-auth ─────────────────────────────
  const unlock = useCallback((reason = 'pin_verified') => {
    markSessionAuthenticated();
    rotateSession('reauth_unlock');
    audit.sessionRotate('reauth_unlock', userId);
    audit.authSuccess(reason, userId);
    setIsLocked(false);
    setShowWarning(false);
  }, [userId]);

  // ── Dismiss warning (user tapped "Stay") ───────────────────────────────
  const dismissWarning = useCallback(() => {
    setShowWarning(false);
    // Activity already resets the timer through the event listeners,
    // but explicitly update session to ensure server-visible heartbeat
    markSessionAuthenticated();
  }, []);

  // ── Force lock (programmatic — e.g. from ATO engine) ──────────────────
  const forceLock = useCallback((reason = 'programmatic') => {
    audit.sessionExpire(reason, userId);
    clearSession();
    setIsLocked(true);
    setShowWarning(false);
  }, [userId]);

  return { isLocked, showWarning, unlock, dismissWarning, forceLock, sessionAge };
}