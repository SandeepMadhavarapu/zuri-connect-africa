/**
 * Zuri Connect Africa — Auth API Layer
 */

import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { mapSessionUser } from '@/lib/auth/authSession.js';
import { obs, METRICS } from '@/lib/observability';
import { emit, EVENTS } from '@/lib/eventBus';
import { audit } from '@/lib/auditLogger';
import { recordFailedAttempt, clearFailedAttempts } from '@/lib/security';
import { simulateBiometricResult } from '@/lib/demoMode';
import { getClientDemoPolicy } from '@/config/clientSecurityPolicy.js';

export async function register(email, password, { fullName } = {}) {
  const trace = obs.startTrace('auth.register');
  try {
    obs.info('auth.register attempt', { email });
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName || '',
        },
        emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/` : undefined,
      },
    });
    if (error) throw error;
    clearFailedAttempts();
    obs.endTrace(trace.traceId);
    return data.user ? mapSessionUser(data.user) : null;
  } catch (err) {
    obs.track(METRICS.AUTH_FAILURE_COUNT, 1);
    recordFailedAttempt();
    emit(EVENTS.AUTH_FAILED, { email, reason: err.message });
    audit.authFailure('register', email);
    obs.endTrace(trace.traceId);
    throw err;
  }
}

export async function login(email, password) {
  const trace = obs.startTrace('auth.login');
  try {
    obs.info('auth.login attempt', { email });
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const mapped = mapSessionUser(data.user);
    clearFailedAttempts();
    obs.endTrace(trace.traceId);
    return mapped;
  } catch (err) {
    obs.track(METRICS.AUTH_FAILURE_COUNT, 1);
    recordFailedAttempt();
    emit(EVENTS.AUTH_FAILED, { email, reason: err.message });
    audit.authFailure('login', email);
    obs.endTrace(trace.traceId);
    throw err;
  }
}

export async function logout(redirectUrl) {
  obs.info('auth.logout');
  audit.logout('logout', null);
  emit(EVENTS.SESSION_LOCKED, { reason: 'logout' });
  const supabase = getSupabaseBrowserClient();
  await supabase.auth.signOut({ scope: 'global' });
  if (redirectUrl) {
    window.location.href = redirectUrl;
  }
}

export async function refreshSession() {
  const trace = obs.startTrace('auth.refreshSession');
  try {
    const supabase = getSupabaseBrowserClient();
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!session?.user) throw new Error('No session');
    const user = mapSessionUser(session.user);
    obs.endTrace(trace.traceId);
    return user;
  } catch (err) {
    obs.error('auth.refreshSession failed', { error: err.message });
    obs.endTrace(trace.traceId);
    throw err;
  }
}

export async function verifyBiometric(type, userId) {
  const trace = obs.startTrace(`auth.verifyBiometric.${type}`);
  try {
    obs.info('auth.verifyBiometric', { type, userId });
    if (!getClientDemoPolicy().allowBiometricClientSimulation) {
      obs.info('auth.verifyBiometric blocked by client security policy', { type, userId });
      obs.endTrace(trace.traceId);
      return {
        success: false,
        confidence: 0,
        policyDenied: true,
        stages: [],
        totalMs: 0,
      };
    }
    const result = await simulateBiometricResult(type);

    if (!result.success) {
      obs.track(METRICS.AUTH_FAILURE_COUNT, 1, { type });
      recordFailedAttempt();
      emit(EVENTS.AUTH_FAILED, { userId, type, reason: 'biometric_mismatch' });
      audit.authFailure(type, userId);
    }

    obs.endTrace(trace.traceId);
    return result;
  } catch (err) {
    obs.error('auth.verifyBiometric failed', { error: err.message, type });
    obs.endTrace(trace.traceId);
    throw err;
  }
}
