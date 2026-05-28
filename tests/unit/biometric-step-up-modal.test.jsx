/**
 * BiometricStepUpModal + useBiometricStepUp tests.
 *
 * These cover:
 *  - Modal asks the backend for a fresh challenge BEFORE any biometric prompt.
 *  - navigator.credentials.get is called with the server-issued challenge bytes
 *    and the action-bound allow_credentials list.
 *  - Assertion is forwarded to onSubmit (which the page wires to
 *    completeServerStepUp). Frontend never sets verified=true by itself —
 *    success only happens after onSubmit returns ok.
 *  - Cancelled biometric blocks the action.
 *  - Failed biometric (server rejects) blocks the action.
 *  - Unsupported / no credential surfaces the PIN fallback path.
 *  - No raw assertions, challenges, or tokens are logged on failure.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const SERVER_CHALLENGE = 'dGVzdC1jaGFsbGVuZ2U'; // 'test-challenge'
const SERVER_CHALLENGE_ROW_ID = 'webauthn-challenge-row-id-1';
const SERVER_RP_ID = 'zuri.local';
const STEP_UP_CHALLENGE_ID = 'step-up-1';
const PENDING_PAYMENT_ID = 'pending-1';

function installCredentialsMock({ shouldCancel = false, shouldThrow = null } = {}) {
  const getSpy = vi.fn(async () => {
    if (shouldCancel) {
      const err = new Error('User cancelled');
      err.name = 'NotAllowedError';
      throw err;
    }
    if (shouldThrow) throw shouldThrow;
    return {
      rawId: new Uint8Array([0x10, 0x20]).buffer,
      response: {
        clientDataJSON: new Uint8Array([0x30, 0x40]).buffer,
        authenticatorData: new Uint8Array([0x50, 0x60]).buffer,
        signature: new Uint8Array([0x70, 0x80]).buffer,
      },
    };
  });
  class MockPublicKeyCredential {}
  Object.defineProperty(window, 'PublicKeyCredential', { value: MockPublicKeyCredential, configurable: true });
  Object.defineProperty(navigator, 'credentials', { value: { get: getSpy, create: vi.fn() }, configurable: true });
  return { getSpy };
}

function installFetchMock({
  optionsOk = true,
  optionsError = null,
} = {}) {
  return vi.fn(async (url, init) => {
    if (!String(url).includes('/verify-biometric')) {
      throw new Error(`Unexpected fetch URL ${url}`);
    }
    const body = JSON.parse(init.body);
    if (body.action !== 'get_step_up_assertion_options') {
      throw new Error(`Unexpected verify-biometric action ${body.action}`);
    }
    if (!optionsOk) {
      return { ok: false, status: 410, json: async () => ({ error: optionsError || 'step_up_challenge_expired' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        challenge: SERVER_CHALLENGE,
        challenge_id: SERVER_CHALLENGE_ROW_ID,
        rp_id: SERVER_RP_ID,
        action_type: body.action_type,
        step_up_challenge_id: body.step_up_challenge_id,
        allow_credentials: [{ id: 'AQID', type: 'public-key', transports: ['internal'] }],
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    };
  });
}

vi.mock('@/lib/supabase/client.js', () => ({
  getSupabaseBrowserClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: 'session-token-xyz' } },
        error: null,
      }),
    },
  }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

afterEach(() => {
  delete global.fetch;
});

describe('BiometricStepUpModal — happy path', () => {
  it('asks backend for action-bound challenge BEFORE prompting credentials.get', async () => {
    const { getSpy } = installCredentialsMock();
    const fetchSpy = installFetchMock();
    global.fetch = fetchSpy;

    const onSubmit = vi.fn(async () => ({ ok: true }));
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={onSubmit}
      />
    );

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const firstCall = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(firstCall.action).toBe('get_step_up_assertion_options');
    expect(firstCall.step_up_challenge_id).toBe(STEP_UP_CHALLENGE_ID);
    expect(firstCall.action_type).toBe('payment_send');
    expect(fetchSpy.mock.calls[0][1].headers.Authorization).toBe('Bearer session-token-xyz');

    await waitFor(() => expect(getSpy).toHaveBeenCalled());
    const passedPublicKey = getSpy.mock.calls[0][0].publicKey;
    // base64url 'dGVzdC1jaGFsbGVuZ2U' = "test-challenge" bytes
    expect(new Uint8Array(passedPublicKey.challenge)).toEqual(new Uint8Array([116, 101, 115, 116, 45, 99, 104, 97, 108, 108, 101, 110, 103, 101]));
    expect(passedPublicKey.userVerification).toBe('required');
    expect(Array.isArray(passedPublicKey.allowCredentials)).toBe(true);
  });

  it('forwards the WebAuthn assertion to onSubmit (frontend cannot self-mark verified)', async () => {
    installCredentialsMock();
    global.fetch = installFetchMock();
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const onVerified = vi.fn();
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={onSubmit}
        onVerified={onVerified}
      />
    );

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const proof = onSubmit.mock.calls[0][0];
    expect(proof).toMatchObject({ challenge_id: SERVER_CHALLENGE_ROW_ID });
    expect(typeof proof.credential_id).toBe('string');
    expect(typeof proof.client_data_json).toBe('string');
    expect(typeof proof.authenticator_data).toBe('string');
    expect(typeof proof.signature).toBe('string');

    await waitFor(() => expect(onVerified).toHaveBeenCalled());
    expect(await screen.findByText(/Verified securely/i)).toBeTruthy();
  });

  it('frontend cannot mark verification successful without backend response', async () => {
    installCredentialsMock();
    global.fetch = installFetchMock();
    const onSubmit = vi.fn(async () => ({ ok: false, message: 'Verification failed. Try again or use PIN.' }));
    const onVerified = vi.fn();
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={onSubmit}
        onVerified={onVerified}
      />
    );

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText(/Verified securely/i)).toBeNull());
    expect(onVerified).not.toHaveBeenCalled();
    const matches = await screen.findAllByText(/Verification failed/i);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe('BiometricStepUpModal — failure paths', () => {
  it('cancelled biometric blocks action and shows cancel copy', async () => {
    installCredentialsMock({ shouldCancel: true });
    global.fetch = installFetchMock();
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const onCancel = vi.fn();
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />
    );

    await waitFor(() => expect(onCancel).toHaveBeenCalled());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(await screen.findByText(/Authorization cancelled/i)).toBeTruthy();
  });

  it('expired challenge from server blocks the action', async () => {
    installCredentialsMock();
    global.fetch = installFetchMock({ optionsOk: false, optionsError: 'step_up_challenge_expired' });
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={onSubmit}
      />
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(onSubmit).not.toHaveBeenCalled();
    const matches = await screen.findAllByText(/Verification failed|Try again|Use PIN/i);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('WebAuthn unsupported (no PublicKeyCredential) surfaces PIN fallback', async () => {
    // Wipe PublicKeyCredential
    Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
    global.fetch = installFetchMock();
    const onSubmit = vi.fn(async () => ({ ok: true }));
    const onFallbackToPin = vi.fn();
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={onSubmit}
        onFallbackToPin={onFallbackToPin}
      />
    );

    await waitFor(() => expect(screen.queryByText(/Biometric unavailable/i)).not.toBeNull());
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /use pin instead/i }));
    expect(onFallbackToPin).toHaveBeenCalled();
  });

  it('does not log tokens, challenges, credential ids, or raw assertions on failure', async () => {
    installCredentialsMock({ shouldCancel: true });
    global.fetch = installFetchMock();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={vi.fn(async () => ({ ok: true }))}
      />
    );

    await waitFor(() => expect(screen.queryByText(/Authorization cancelled/i)).not.toBeNull());

    const joined = JSON.stringify(warnSpy.mock.calls.concat(errorSpy.mock.calls));
    expect(joined).not.toContain('session-token-xyz');
    expect(joined).not.toContain(SERVER_CHALLENGE);
    expect(joined).not.toContain(SERVER_CHALLENGE_ROW_ID);
    expect(joined).not.toContain('authenticator_data');
    expect(joined).not.toContain('client_data_json');
    expect(joined).not.toContain('signature=');
  });
});

describe('BiometricStepUpModal — no credentials enrolled', () => {
  it('shows fallback to PIN when server says no credentials are enrolled', async () => {
    installCredentialsMock();
    global.fetch = installFetchMock({ optionsOk: false, optionsError: 'no_credentials_enrolled' });
    const onFallbackToPin = vi.fn();
    const { default: BiometricStepUpModal } = await import('@/components/security/BiometricStepUpModal.jsx');

    render(
      <BiometricStepUpModal
        open
        stepUpChallengeId={STEP_UP_CHALLENGE_ID}
        actionType="payment_send"
        amount={2500}
        recipientLabel="Maria"
        onSubmit={vi.fn(async () => ({ ok: true }))}
        onFallbackToPin={onFallbackToPin}
      />
    );

    await waitFor(() => expect(screen.queryAllByText(/Biometric unavailable|No biometric|Use PIN/i).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: /use pin instead/i }));
    expect(onFallbackToPin).toHaveBeenCalled();
  });
});
