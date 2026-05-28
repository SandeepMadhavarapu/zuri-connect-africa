/**
 * Profile top-card formatting tests.
 *
 * These guard the UI/data polish for the Account/Profile screen — namely that
 * the user's name is title-cased and the phone is rendered in the canonical
 * "+254 712 345 678" form, with a safe fallback when phone is missing.
 *
 * We mock heavy dependencies (Biometric panel, RBAC, supabase client) so the
 * test stays focused on display logic and runs in jsdom without network.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';

vi.mock('@/components/security/BiometricSecurityPanel', () => ({
  default: () => <div data-testid="biometric-panel-stub" />,
}));

vi.mock('@/lib/rbac', () => ({
  canViewFraudDashboard: () => false,
}));

const authMock = vi.hoisted(() => ({ user: null, logout: vi.fn() }));
vi.mock('@/lib/AuthContext', () => ({
  useAuth: () => authMock,
}));

async function renderProfileWith(user) {
  authMock.user = user;
  const { default: Profile } = await import('@/pages/Profile.jsx');
  return render(
    <MemoryRouter>
      <Profile />
    </MemoryRouter>,
  );
}

describe('Profile — user display formatting', () => {
  it('renders the canonical +254 formatted phone number', async () => {
    await renderProfileWith({
      full_name: 'madhavarapu sandeep',
      email: 'sandeep@example.com',
      phone: '254712345678',
    });
    const phoneEl = await screen.findByTestId('profile-phone');
    expect(phoneEl).toHaveTextContent('+254 712 345 678');
    expect(phoneEl.textContent).not.toMatch(/^254\d/); // no raw MSISDN
  });

  it('renders a title-cased display name in the profile header', async () => {
    await renderProfileWith({
      full_name: 'madhavarapu sandeep',
      email: 'sandeep@example.com',
      phone: '+254712345678',
    });
    // The header h2 carries the title-cased name; it must not show "madhavarapu sandeep".
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Madhavarapu Sandeep');
    expect(screen.queryByText('madhavarapu sandeep')).not.toBeInTheDocument();
  });

  it('shows "Phone not linked" fallback without crashing when phone is missing', async () => {
    await renderProfileWith({
      full_name: 'Madhavarapu Sandeep',
      email: 'sandeep@example.com',
      phone: '',
    });
    const phoneEl = await screen.findByTestId('profile-phone');
    expect(phoneEl).toHaveTextContent('Phone not linked');
  });

  it('survives a fully empty user object (no name, no phone, no email)', async () => {
    // Should render the fallback name and fallback phone with no thrown errors.
    await renderProfileWith({});
    const phoneEl = await screen.findByTestId('profile-phone');
    expect(phoneEl).toHaveTextContent('Phone not linked');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Zuri Member');
  });

  it('renders both first and last name initials in the avatar', async () => {
    await renderProfileWith({
      full_name: 'madhavarapu sandeep',
      phone: '+254712345678',
    });
    // The avatar shows up to 2 uppercase initials.
    expect(screen.getByText('MS')).toBeInTheDocument();
  });
});
