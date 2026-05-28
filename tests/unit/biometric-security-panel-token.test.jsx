import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  registerBiometric: vi.fn(),
  clearBiometricEnrollment: vi.fn(),
  getPlatformAuthenticators: vi.fn(),
  isBiometricSupported: vi.fn(),
  isBiometricEnrolled: vi.fn(),
  getBiometricEnrollmentInfo: vi.fn(),
}));

vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => ({
    user: {
      email: 'user@example.com',
      full_name: 'Test User',
    },
  }),
}));

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: mocks.getSession,
    },
  }),
}));

const BIOMETRIC_ENROLLED_FALLBACK_LABEL = 'Enrolled on this device';

function formatBiometricEnrolledLabel(input) {
  if (input === null || input === undefined || input === '') return BIOMETRIC_ENROLLED_FALLBACK_LABEL;
  const d = input instanceof Date ? input : new Date(input);
  if (!d || Number.isNaN(d.getTime())) return BIOMETRIC_ENROLLED_FALLBACK_LABEL;
  return `Enrolled ${new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(d)}`;
}

vi.mock('@/lib/biometricAuth', () => ({
  BIOMETRIC_SESSION_REQUIRED_MESSAGE: 'Please sign in again before enabling biometrics.',
  BIOMETRIC_ENROLLED_FALLBACK_LABEL,
  isBiometricSupported: mocks.isBiometricSupported,
  getPlatformAuthenticators: mocks.getPlatformAuthenticators,
  registerBiometric: mocks.registerBiometric,
  clearBiometricEnrollment: mocks.clearBiometricEnrollment,
  isBiometricEnrolled: mocks.isBiometricEnrolled,
  getBiometricEnrollmentInfo: mocks.getBiometricEnrollmentInfo,
  formatBiometricEnrolledLabel,
}));

describe('BiometricSecurityPanel session wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isBiometricSupported.mockReturnValue(true);
    mocks.getPlatformAuthenticators.mockResolvedValue(true);
    mocks.isBiometricEnrolled.mockReturnValue(false);
    mocks.getBiometricEnrollmentInfo.mockResolvedValue(null);
    mocks.clearBiometricEnrollment.mockResolvedValue({ success: true });
    mocks.registerBiometric.mockResolvedValue({ success: true });
  });

  it('passes current Supabase access token into biometric enrollment', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'session-token-abc' } },
      error: null,
    });

    const { default: BiometricSecurityPanel } = await import('@/components/security/BiometricSecurityPanel.jsx');
    render(<BiometricSecurityPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /enable biometric/i }));

    await waitFor(() => {
      expect(mocks.registerBiometric).toHaveBeenCalledWith(
        'user@example.com',
        'Test User',
        'session-token-abc'
      );
    });
  });

  it('fails closed with clean message when Supabase session is missing', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    const { default: BiometricSecurityPanel } = await import('@/components/security/BiometricSecurityPanel.jsx');
    render(<BiometricSecurityPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /enable biometric/i }));

    expect(await screen.findByText('Please sign in again before enabling biometrics.')).toBeInTheDocument();
    expect(mocks.registerBiometric).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('shows a clean enrolled date when enrollmentInfo.enrolledAt is a valid ISO string', async () => {
    mocks.isBiometricEnrolled.mockReturnValue(true);
    mocks.getBiometricEnrollmentInfo.mockResolvedValue({
      enrolled: true,
      credentialId: 'cred-1',
      enrolledAt: '2026-05-19T08:30:00.000Z',
    });

    const { default: BiometricSecurityPanel } = await import('@/components/security/BiometricSecurityPanel.jsx');
    render(<BiometricSecurityPanel />);

    // "Enabled" pill must still render alongside the date label.
    expect(await screen.findByText(/^Enabled$/)).toBeInTheDocument();

    // Match "Enrolled <something>" but never "Invalid Date".
    const label = await screen.findByText(/^Enrolled\s+/);
    expect(label.textContent).not.toMatch(/Invalid Date/);
    expect(label.textContent).toMatch(/Enrolled\s+\w/);
  });

  it('falls back to "Enrolled on this device" when enrolledAt is missing', async () => {
    mocks.isBiometricEnrolled.mockReturnValue(true);
    mocks.getBiometricEnrollmentInfo.mockResolvedValue({
      enrolled: true,
      credentialId: 'cred-1',
      enrolledAt: null,
    });

    const { default: BiometricSecurityPanel } = await import('@/components/security/BiometricSecurityPanel.jsx');
    render(<BiometricSecurityPanel />);

    expect(await screen.findByText('Enrolled on this device')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(await screen.findByText(/^Enabled$/)).toBeInTheDocument();
  });

  it('falls back safely when enrolledAt is an invalid string', async () => {
    mocks.isBiometricEnrolled.mockReturnValue(true);
    mocks.getBiometricEnrollmentInfo.mockResolvedValue({
      enrolled: true,
      credentialId: 'cred-1',
      enrolledAt: 'not-a-date',
    });

    const { default: BiometricSecurityPanel } = await import('@/components/security/BiometricSecurityPanel.jsx');
    render(<BiometricSecurityPanel />);

    expect(await screen.findByText('Enrolled on this device')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
  });

  it('does not log access tokens when enrollment returns an error', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.getSession.mockResolvedValue({
      data: { session: { access_token: 'secret-session-token' } },
      error: null,
    });
    mocks.registerBiometric.mockResolvedValue({
      success: false,
      error: 'Access token required for server-side enrollment',
    });

    const { default: BiometricSecurityPanel } = await import('@/components/security/BiometricSecurityPanel.jsx');
    render(<BiometricSecurityPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /enable biometric/i }));

    expect(await screen.findByText('Please sign in again before enabling biometrics.')).toBeInTheDocument();
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('secret-session-token');
  });
});
