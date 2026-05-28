import { describe, it, expect } from 'vitest';
import { getRouteProtection, requiresStepUp, requiresAdmin } from '@/lib/routeGuard.js';

describe('route guard configuration', () => {
  it('send and paybill require step-up', () => {
    expect(getRouteProtection('/send').level).toBe('stepup');
    expect(getRouteProtection('/paybill').level).toBe('stepup');
  });

  it('admin routes require admin level', () => {
    expect(getRouteProtection('/admin').level).toBe('admin');
    expect(getRouteProtection('/audit').level).toBe('admin');
    expect(requiresAdmin('/admin')).toBe(true);
  });

  it('unknown paths fail-secure to auth', () => {
    expect(getRouteProtection('/unknown-route').level).toBe('auth');
  });

  it('requiresStepUp for financial surfaces', () => {
    expect(requiresStepUp('/wallet')).toBe(true);
    expect(requiresStepUp('/budget')).toBe(false);
  });
});
