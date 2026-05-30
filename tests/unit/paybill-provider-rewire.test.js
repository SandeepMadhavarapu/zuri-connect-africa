/**
 * Structural regression tests for the Phase 3 provider directory rewire.
 *
 * Verifies that Paybill.jsx:
 *   - fetches from the provider-search Edge Function via providerService
 *   - retains LOCAL_FALLBACK_BILLERS as a defensive offline fallback
 *   - no longer carries the outdated "is NOT in place today" gate copy
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const SOURCE = readFileSync(resolve(ROOT, 'src/pages/Paybill.jsx'), 'utf8');

describe('Paybill · Phase 3 provider directory rewire', () => {
  it('imports searchProviders from @/services/providerService.js', () => {
    expect(SOURCE).toMatch(
      /import\s*\{[^}]*searchProviders[^}]*\}\s*from\s*['"]@\/services\/providerService\.js['"]/,
    );
  });

  it('imports useEffect from react', () => {
    expect(SOURCE).toMatch(/import\s*\{[^}]*useEffect[^}]*\}\s*from\s*['"]react['"]/);
  });

  it('declares directoryEntries state and its setter', () => {
    expect(SOURCE).toMatch(/directoryEntries/);
    expect(SOURCE).toMatch(/setDirectoryEntries/);
  });

  it('calls searchProviders inside a useEffect', () => {
    expect(SOURCE).toMatch(/useEffect\s*\(/);
    expect(SOURCE).toMatch(/searchProviders\s*\(/);
  });

  it('LOCAL_FALLBACK_BILLERS is still defined as a const array (defensive fallback)', () => {
    expect(SOURCE).toMatch(/const\s+LOCAL_FALLBACK_BILLERS\s*=/);
  });

  it('includes the Phase 3 activation comment with PROVIDER_DIRECTORY_ACTIVATION.md reference', () => {
    expect(SOURCE).toMatch(/provider directory backend is now live/i);
    expect(SOURCE).toMatch(/PROVIDER_DIRECTORY_ACTIVATION\.md/);
  });

  it('does NOT contain the outdated "is NOT in place today" language', () => {
    expect(SOURCE).not.toMatch(/is NOT in place today/);
  });

  it('does NOT contain the outdated "is on the roadmap" provider-gate language', () => {
    expect(SOURCE).not.toMatch(/server-side rejection.*is on the roadmap/s);
  });
});
