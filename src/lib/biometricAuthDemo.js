/**
 * Demo integration guide for WebAuthn biometric authentication
 * Shows how to use real biometric auth in any transaction flow
 */

import { isBiometricEnrolled, authenticateBiometric } from './biometricAuth';
import { recordSuccessfulBiometricAuth } from './deviceTrust';

/**
 * Initiate biometric authentication for a transaction
 * @param {string} userId - User ID
 * @param {object} options - Transaction context including accessToken
 * @returns {Promise<boolean>} - Whether auth succeeded
 */
export async function requireBiometricAuth(userId, options = {}) {
  const { amount = 0, recipient = '', actionType = 'transaction', accessToken = '' } = options;

  if (!isBiometricEnrolled(userId)) {
    console.warn('[BiometricDemo] Biometric not enrolled for user:', userId);
    return false;
  }

  try {
    const result = await authenticateBiometric(userId, accessToken);

    if (result.success) {
      recordSuccessfulBiometricAuth();
      console.log('[BiometricDemo] Auth success:', { amount, recipient, actionType });
      return true;
    } else {
      console.warn('[BiometricDemo] Auth failed:', result.error);
      return false;
    }
  } catch (e) {
    console.error('[BiometricDemo] Auth error:', e);
    return false;
  }
}

/**
 * Example: Require biometric for high-value transfers
 * Used in Send.jsx or similar transaction flows
 */
export async function shouldRequireBiometric(amount) {
  // Require biometric for transfers > KSh 50,000
  return amount > 50000;
}

/**
 * Example transaction flow with biometric
 */
export async function executeSecureTransfer(userId, transferData) {
  const { amount, recipient, accessToken = '' } = transferData;

  const needsBio = await shouldRequireBiometric(amount);

  if (needsBio) {
    const authOk = await requireBiometricAuth(userId, {
      amount,
      recipient,
      actionType: 'transfer',
      accessToken,
    });

    if (!authOk) {
      return { success: false, error: 'Biometric authentication required' };
    }
  }

  console.log('[BiometricDemo] Transfer authorized:', transferData);
  return { success: true, transactionId: `TXN-${Date.now()}` };
}