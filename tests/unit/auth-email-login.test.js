import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  clearFailedAttempts: vi.fn(),
  recordFailedAttempt: vi.fn(),
  emit: vi.fn(),
  authFailure: vi.fn(),
  startTrace: vi.fn(() => ({ traceId: 'trace-1' })),
  endTrace: vi.fn(),
  info: vi.fn(),
  track: vi.fn(),
}));

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: vi.fn(() => ({
    auth: {
      signInWithPassword: mocks.signInWithPassword,
    },
  })),
}));

vi.mock('@/lib/observability', () => ({
  METRICS: { AUTH_FAILURE_COUNT: 'auth_failure_count' },
  obs: {
    startTrace: mocks.startTrace,
    endTrace: mocks.endTrace,
    info: mocks.info,
    track: mocks.track,
  },
}));

vi.mock('@/lib/eventBus', () => ({
  EVENTS: { AUTH_FAILED: 'AUTH_FAILED' },
  emit: mocks.emit,
}));

vi.mock('@/lib/auditLogger', () => ({
  audit: { authFailure: mocks.authFailure },
}));

vi.mock('@/lib/security', () => ({
  clearFailedAttempts: mocks.clearFailedAttempts,
  recordFailedAttempt: mocks.recordFailedAttempt,
}));

vi.mock('@/lib/demoMode', () => ({
  simulateBiometricResult: vi.fn(),
}));

vi.mock('@/config/clientSecurityPolicy.js', () => ({
  getClientDemoPolicy: vi.fn(() => ({ allowBiometricClientSimulation: false })),
}));

describe('email login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('still signs in with Supabase email/password auth', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: {
        user: {
          id: 'email-user',
          email: 'a@example.com',
          user_metadata: { full_name: 'Email User' },
          app_metadata: { role: 'customer' },
        },
      },
      error: null,
    });

    const { login } = await import('@/api/auth.js');
    const user = await login('a@example.com', 'correct-password');

    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@example.com',
      password: 'correct-password',
    });
    expect(user).toMatchObject({
      id: 'email-user',
      email: 'a@example.com',
      full_name: 'Email User',
      role: 'customer',
    });
    expect(mocks.clearFailedAttempts).toHaveBeenCalled();
  });
});
