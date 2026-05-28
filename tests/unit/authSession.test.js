import { describe, it, expect } from 'vitest';
import { mapSessionUser } from '@/lib/auth/authSession.js';

describe('auth session mapping', () => {
  it('maps Supabase-like user to app user with role', () => {
    const u = mapSessionUser({
      id: 'uuid-1',
      email: 'a@example.com',
      user_metadata: { full_name: 'Test User', role: 'customer' },
      app_metadata: {},
      aud: 'authenticated',
      created_at: '2026-01-01',
    });
    expect(u.id).toBe('uuid-1');
    expect(u.email).toBe('a@example.com');
    expect(u.full_name).toBe('Test User');
    expect(u.role).toBe('customer');
  });

  it('defaults role to customer', () => {
    const u = mapSessionUser({
      id: 'x',
      email: 'b@example.com',
      user_metadata: {},
      app_metadata: {},
    });
    expect(u.role).toBe('customer');
  });
});
