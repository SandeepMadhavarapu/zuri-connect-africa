import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@/api/errorHandling.js';
import { KENYAN_PHONE_ERROR } from '@/lib/auth/phoneOtpSession.js';
import PhoneEntry from '@/components/auth/PhoneEntry.jsx';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  invokeEdgeFunction: vi.fn(),
  signInWithOtp: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock('@/api/client.js', () => ({
  invokeEdgeFunction: mocks.invokeEdgeFunction,
}));

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: mocks.getSession,
      signInWithOtp: mocks.signInWithOtp,
      verifyOtp: mocks.verifyOtp,
    },
  }),
}));

async function renderPhoneOtpAuth() {
  const { default: PhoneOTPAuth } = await import('@/components/auth/PhoneOTPAuth.jsx');
  return render(
    <MemoryRouter>
      <PhoneOTPAuth embedded />
    </MemoryRouter>,
  );
}

describe('Phone OTP Kenyan mobile input UX', () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
    mocks.invokeEdgeFunction.mockReset();
    mocks.signInWithOtp.mockReset();
    mocks.verifyOtp.mockReset();

    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    mocks.invokeEdgeFunction.mockResolvedValue({ success: true });
    mocks.signInWithOtp.mockRejectedValue(new Error('Supabase SMS unavailable'));
  });

  it('tells users they can enter Kenyan mobile numbers starting with 07 or 01', () => {
    render(<PhoneEntry onSubmit={vi.fn()} loading={false} error="" />);

    expect(screen.getByPlaceholderText('0712 345 678 or 0143 305 099')).toBeInTheDocument();
    expect(
      screen.getByText('Enter your Kenyan mobile number starting with 07 or 01.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Safaricom number/i)).not.toBeInTheDocument();
    expect(screen.queryByText('+254')).not.toBeInTheDocument();
  });

  it('sends normalized E.164 phone numbers to sendOTP for natural Kenyan local input', async () => {
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '0712 345 678' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => {
      expect(mocks.invokeEdgeFunction).toHaveBeenCalledWith('sendOTP', {
        phone: '+254712345678',
      });
    });
    expect(screen.queryByText(KENYAN_PHONE_ERROR)).not.toBeInTheDocument();
  });

  it('accepts 0110 Kenyan mobile ranges and sends normalized E.164 to sendOTP', async () => {
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '0110 123 456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => {
      expect(mocks.invokeEdgeFunction).toHaveBeenCalledWith('sendOTP', {
        phone: '+254110123456',
      });
    });
  });

  it('accepts 0143 Kenyan mobile ranges and sends normalized E.164 to sendOTP', async () => {
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '0143 305 099' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    await waitFor(() => {
      expect(mocks.invokeEdgeFunction).toHaveBeenCalledWith('sendOTP', {
        phone: '+254143305099',
      });
    });
  });

  it('maps safe 502 OTP provider codes to polished copy', async () => {
    mocks.invokeEdgeFunction.mockRejectedValue(new ApiError('SMS_SEND_FAILED', {
      status: 502,
      body: { ok: false, error: 'SMS_SEND_FAILED' },
    }));
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '0143 305 099' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(
      await screen.findByText('We could not send the code right now. Please try again.'),
    ).toBeInTheDocument();
  });

  it('maps send-otp rate_limited (429) to a clear retry-window message in minutes', async () => {
    // Mirrors the real server payload that previously surfaced as the generic
    // "Failed to send OTP. Please check your connection and try again." copy.
    mocks.invokeEdgeFunction.mockRejectedValue(new ApiError('rate_limited', {
      status: 429,
      body: { ok: false, error: 'rate_limited', retryAfterSeconds: 1320, blocked: true },
    }));
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '0143 305 099' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(
      await screen.findByText('Too many attempts. Please try again in about 22 minutes.'),
    ).toBeInTheDocument();
    // The generic connectivity fallback must NOT appear when we have a
    // structured rate-limit signal.
    expect(
      screen.queryByText('Failed to send OTP. Please check your connection and try again.'),
    ).not.toBeInTheDocument();
  });

  it('also handles 200-with-success:false rate_limited bodies returned in-band', async () => {
    // Some retry/legacy paths can resolve with a 200 body that still says
    // success:false; the UI must treat that the same way.
    mocks.invokeEdgeFunction.mockResolvedValue({
      ok: false,
      success: false,
      error: 'rate_limited',
      retryAfterSeconds: 60,
      blocked: true,
    });
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '0143 305 099' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(
      await screen.findByText('Too many attempts. Please try again in about 1 minute.'),
    ).toBeInTheDocument();
  });

  it('maps OTP service configuration failures to polished copy', async () => {
    mocks.invokeEdgeFunction.mockRejectedValue(new ApiError('SMS_PROVIDER_MISCONFIGURED', {
      status: 503,
      body: { ok: false, error: 'SMS_PROVIDER_MISCONFIGURED' },
    }));
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '0143 305 099' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(
      await screen.findByText('OTP service is not ready. Please try again shortly.'),
    ).toBeInTheDocument();
  });

  it('shows polished validation copy for invalid short numbers and does not call sendOTP', async () => {
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '07123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(await screen.findByText(KENYAN_PHONE_ERROR)).toBeInTheDocument();
    expect(mocks.invokeEdgeFunction).not.toHaveBeenCalled();
  });

  it('rejects incomplete 01 numbers with polished validation copy', async () => {
    await renderPhoneOtpAuth();

    fireEvent.change(screen.getByLabelText(/phone number/i), {
      target: { value: '014330509' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send code/i }));

    expect(await screen.findByText(KENYAN_PHONE_ERROR)).toBeInTheDocument();
    expect(mocks.invokeEdgeFunction).not.toHaveBeenCalled();
  });
});
