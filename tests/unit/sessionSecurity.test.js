import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSession,
  getSession,
  validateSession,
  clearSession,
  markSessionAuthenticated,
} from '@/lib/sessionSecurity.js';

describe('session security validation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('validateSession fails when no session', () => {
    clearSession();
    const v = validateSession();
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('no_session');
  });

  it('validateSession passes for fresh session', () => {
    createSession();
    markSessionAuthenticated();
    const v = validateSession();
    expect(v.valid).toBe(true);
  });

  it('validateSession fails on hard cap expiry', () => {
    createSession();
    const s = getSession();
    s.hardCapAt = Date.now() - 1000;
    s.lastActive = Date.now();
    sessionStorage.setItem('zuri_session_v3', JSON.stringify(s));
    const v = validateSession();
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('hard_cap_expired');
  });

  it('validateSession fails on inactivity', () => {
    createSession();
    const s = getSession();
    s.lastActive = Date.now() - 10 * 60 * 1000;
    sessionStorage.setItem('zuri_session_v3', JSON.stringify(s));
    const v = validateSession();
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('inactivity_timeout');
  });
});
