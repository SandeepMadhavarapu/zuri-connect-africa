/**
 * useBiometricStepUp — React hook around the action-bound WebAuthn step-up
 * flow. Manages a small state machine so consumers don't have to re-implement
 * it:
 *
 *   idle → requesting → signing → submitting → verified | failed | cancelled
 *
 * The hook NEVER sets `verified` until the submit callback returns ok. The
 * frontend cannot self-mark verification — that's the server's job.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BIOMETRIC_CANCELLED_MESSAGE,
  BIOMETRIC_NO_CREDENTIAL_MESSAGE,
  BIOMETRIC_SESSION_REQUIRED_MESSAGE,
  BIOMETRIC_UNSUPPORTED_MESSAGE,
  BIOMETRIC_VERIFICATION_FAILED_MESSAGE,
  isWebAuthnSupported,
  performBiometricStepUp,
} from '@/lib/biometricStepUp.js';

export const BIOMETRIC_STEP_UP_STATES = Object.freeze({
  IDLE:        'idle',
  REQUESTING:  'requesting',
  SIGNING:     'signing',
  SUBMITTING:  'submitting',
  VERIFIED:    'verified',
  FAILED:      'failed',
  CANCELLED:   'cancelled',
  UNAVAILABLE: 'unavailable',
});

const FAILURE_CODE_TO_MESSAGE = Object.freeze({
  biometric_unsupported:        BIOMETRIC_UNSUPPORTED_MESSAGE,
  no_credentials_enrolled:      BIOMETRIC_NO_CREDENTIAL_MESSAGE,
  biometric_cancelled:          BIOMETRIC_CANCELLED_MESSAGE,
  biometric_failed:             BIOMETRIC_VERIFICATION_FAILED_MESSAGE,
  BIOMETRIC_SESSION_REQUIRED:   BIOMETRIC_SESSION_REQUIRED_MESSAGE,
  step_up_challenge_expired:    'This authorization expired. Try the action again.',
  pending_payment_not_resumable: 'This payment is no longer pending. Refresh and try again.',
});

/**
 * @param {object} params
 * @param {(proof: object) => Promise<{ ok: boolean, error?: string, message?: string }>} params.onSubmit
 *   Called with the WebAuthn proof. Must round-trip through a server function
 *   (e.g. completeServerStepUp) that actually verifies the assertion. Must
 *   resolve to `{ ok: true }` on success.
 * @param {() => void} [params.onVerified]   Optional callback on success.
 * @param {() => void} [params.onCancel]     Optional callback on user cancel.
 */
export function useBiometricStepUp({ onSubmit, onVerified, onCancel } = {}) {
  const [state, setState] = useState(BIOMETRIC_STEP_UP_STATES.IDLE);
  const [errorMessage, setErrorMessage] = useState('');
  const [errorCode, setErrorCode] = useState('');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const safeSetState = useCallback((nextState) => {
    if (isMounted.current) setState(nextState);
  }, []);

  const start = useCallback(async ({ stepUpChallengeId, actionType, binding, accessToken } = {}) => {
    if (!isWebAuthnSupported()) {
      setErrorCode('biometric_unsupported');
      setErrorMessage(BIOMETRIC_UNSUPPORTED_MESSAGE);
      safeSetState(BIOMETRIC_STEP_UP_STATES.UNAVAILABLE);
      return { ok: false, code: 'biometric_unsupported' };
    }

    safeSetState(BIOMETRIC_STEP_UP_STATES.REQUESTING);
    setErrorCode('');
    setErrorMessage('');

    safeSetState(BIOMETRIC_STEP_UP_STATES.SIGNING);
    const stepUpResult = await performBiometricStepUp({
      stepUpChallengeId,
      actionType,
      binding,
      accessToken,
    });

    if (!stepUpResult.ok) {
      const isCancel = stepUpResult.code === 'biometric_cancelled';
      const isUnsupported = stepUpResult.code === 'biometric_unsupported';
      const isMissingCred = stepUpResult.code === 'no_credentials_enrolled';
      setErrorCode(stepUpResult.code);
      setErrorMessage(FAILURE_CODE_TO_MESSAGE[stepUpResult.code] || stepUpResult.message || BIOMETRIC_VERIFICATION_FAILED_MESSAGE);
      safeSetState(
        isCancel ? BIOMETRIC_STEP_UP_STATES.CANCELLED
        : isUnsupported || isMissingCred ? BIOMETRIC_STEP_UP_STATES.UNAVAILABLE
        : BIOMETRIC_STEP_UP_STATES.FAILED
      );
      if (isCancel) onCancel?.();
      return stepUpResult;
    }

    if (typeof onSubmit !== 'function') {
      const e = new Error('useBiometricStepUp requires an onSubmit callback');
      setErrorMessage(BIOMETRIC_VERIFICATION_FAILED_MESSAGE);
      setErrorCode('missing_submit');
      safeSetState(BIOMETRIC_STEP_UP_STATES.FAILED);
      throw e;
    }

    safeSetState(BIOMETRIC_STEP_UP_STATES.SUBMITTING);
    let submitResult;
    try {
      submitResult = await onSubmit(stepUpResult.proof);
    } catch (err) {
      // Submit errors are surfaced as user-facing failures. The server-side
      // verification is the source of truth; never mark verified locally.
      const message = err?.message || BIOMETRIC_VERIFICATION_FAILED_MESSAGE;
      setErrorCode('submit_failed');
      setErrorMessage(message);
      safeSetState(BIOMETRIC_STEP_UP_STATES.FAILED);
      return { ok: false, code: 'submit_failed', message };
    }

    if (submitResult?.ok) {
      safeSetState(BIOMETRIC_STEP_UP_STATES.VERIFIED);
      onVerified?.();
      return submitResult;
    }

    setErrorCode(submitResult?.code || 'submit_failed');
    setErrorMessage(submitResult?.message || BIOMETRIC_VERIFICATION_FAILED_MESSAGE);
    safeSetState(BIOMETRIC_STEP_UP_STATES.FAILED);
    return submitResult || { ok: false, code: 'submit_failed' };
  }, [onSubmit, onVerified, onCancel, safeSetState]);

  const reset = useCallback(() => {
    setErrorMessage('');
    setErrorCode('');
    safeSetState(BIOMETRIC_STEP_UP_STATES.IDLE);
  }, [safeSetState]);

  const cancel = useCallback(() => {
    setErrorMessage(BIOMETRIC_CANCELLED_MESSAGE);
    setErrorCode('biometric_cancelled');
    safeSetState(BIOMETRIC_STEP_UP_STATES.CANCELLED);
    onCancel?.();
  }, [onCancel, safeSetState]);

  return {
    state,
    errorCode,
    errorMessage,
    isBusy: state === BIOMETRIC_STEP_UP_STATES.REQUESTING || state === BIOMETRIC_STEP_UP_STATES.SIGNING || state === BIOMETRIC_STEP_UP_STATES.SUBMITTING,
    isVerified: state === BIOMETRIC_STEP_UP_STATES.VERIFIED,
    isFailure: state === BIOMETRIC_STEP_UP_STATES.FAILED,
    isCancelled: state === BIOMETRIC_STEP_UP_STATES.CANCELLED,
    isUnavailable: state === BIOMETRIC_STEP_UP_STATES.UNAVAILABLE,
    start,
    reset,
    cancel,
  };
}

export default useBiometricStepUp;
