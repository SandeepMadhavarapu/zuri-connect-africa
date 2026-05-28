import { describe, it, expect } from 'vitest';
import { computeClientDemoPolicy } from '@/config/clientSecurityPolicy.js';

describe('computeClientDemoPolicy', () => {
  it('hardens staging regardless of dev flag', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'staging',
      strictEnv: false,
      isViteDev: true,
      allowClientDemoControlsFlag: true,
      isProductionBundle: false,
    });
    expect(p.hardenedSurface).toBe(true);
    expect(p.allowBiometricClientSimulation).toBe(false);
    expect(p.allowBrowserDemoControls).toBe(false);
    expect(p.allowAnonymousDemoFinancials).toBe(false);
    expect(p.allowDefaultDemoPin).toBe(false);
  });

  it('hardens production', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'production',
      strictEnv: false,
      isViteDev: true,
      allowClientDemoControlsFlag: true,
      isProductionBundle: true,
    });
    expect(p.allowDefaultDemoPin).toBe(false);
  });

  it('hardens when strictEnv is true even on local', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'local',
      strictEnv: true,
      isViteDev: true,
      allowClientDemoControlsFlag: true,
      isProductionBundle: false,
    });
    expect(p.allowBrowserDemoControls).toBe(false);
  });

  it('allows relaxed tooling on local + vite dev', () => {
    const p = computeClientDemoPolicy({
      appEnv: 'local',
      strictEnv: false,
      isViteDev: true,
      allowClientDemoControlsFlag: false,
      isProductionBundle: false,
    });
    expect(p.hardenedSurface).toBe(false);
    expect(p.allowBiometricClientSimulation).toBe(true);
    expect(p.allowDefaultDemoPin).toBe(true);
  });

  it('requires explicit flag for preview-style production bundles', () => {
    const noFlag = computeClientDemoPolicy({
      appEnv: 'local',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: false,
      isProductionBundle: true,
    });
    expect(noFlag.hardenedSurface).toBe(true);

    const withFlag = computeClientDemoPolicy({
      appEnv: 'local',
      strictEnv: false,
      isViteDev: false,
      allowClientDemoControlsFlag: true,
      isProductionBundle: true,
    });
    expect(withFlag.allowBrowserDemoControls).toBe(true);
    expect(withFlag.hardenedSurface).toBe(false);
  });
});
