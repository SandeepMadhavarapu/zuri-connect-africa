import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapSessionUser } from '@/lib/auth/authSession.js';

describe('Supabase auth readiness (mocked)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('maps session user for downstream RBAC', async () => {
    const sessionUser = {
      id: '11111111-1111-1111-1111-111111111111',
      email: 'ops@example.com',
      user_metadata: { role: 'auditor' },
      app_metadata: { role: 'auditor' },
    };
    const appUser = mapSessionUser(sessionUser);
    expect(appUser.role).toBe('auditor');
  });

  it('does not trust user_metadata for RBAC role escalation', async () => {
    const sessionUser = {
      id: '22222222-2222-2222-2222-222222222222',
      email: 'customer@example.com',
      user_metadata: { role: 'admin' },
      app_metadata: {},
    };
    const appUser = mapSessionUser(sessionUser);
    expect(appUser.role).toBe('customer');
  });
});
