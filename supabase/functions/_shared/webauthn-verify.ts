import {
  base64ToUint8Array,
  computeWebAuthnBindingHash,
  resolveWebAuthnConfig,
  validateWebAuthnClientData,
  type WebAuthnActionType,
} from './webauthn-config.ts';


function derToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('DER: not a SEQUENCE');
  let offset = der[1] >= 0x80 ? 2 + (der[1] & 0x7f) : 2;
  if (der[offset] !== 0x02) throw new Error('DER: r is not INTEGER');
  offset++;
  const rLen = der[offset++];
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;
  if (der[offset] !== 0x02) throw new Error('DER: s is not INTEGER');
  offset++;
  const sLen = der[offset++];
  const sBytes = der.slice(offset, offset + sLen);
  const r32 = new Uint8Array(32);
  const s32 = new Uint8Array(32);
  const rTrimmed = rBytes.length > 32 ? rBytes.slice(rBytes.length - 32) : rBytes;
  const sTrimmed = sBytes.length > 32 ? sBytes.slice(sBytes.length - 32) : sBytes;
  r32.set(rTrimmed, 32 - rTrimmed.length);
  s32.set(sTrimmed, 32 - sTrimmed.length);
  const p1363 = new Uint8Array(64);
  p1363.set(r32, 0);
  p1363.set(s32, 32);
  return p1363;
}

export type WebAuthnAssertionOptions = {
  /**
   * If set, the WebAuthn challenge MUST have been minted for this exact
   * step-up challenge id. Mismatch = fail closed.
   */
  expectedStepUpChallengeId?: string | null;
  /**
   * If set, the WebAuthn challenge MUST have been minted for this action_type
   * AND its stored binding_hash MUST equal computeWebAuthnBindingHash(...) of
   * these inputs. Mismatch = fail closed. This is the transaction-confirmation
   * guarantee.
   */
  expectedActionType?: WebAuthnActionType | null;
  expectedPendingPaymentId?: string | null;
  expectedAmountMinor?: number | null;
  expectedRecipientSafe?: string | null;
};

/**
 * Full WebAuthn assertion verification with optional action+step-up binding
 * enforcement. The caller is expected to pass `expectedStepUpChallengeId` and
 * `expectedActionType` when consuming an assertion for a sensitive action so
 * the server proves the user intended to authorize THAT specific transaction,
 * not just "any biometric ceremony".
 *
 * Validation steps:
 *  1. Challenge row exists for this user, is not expired, is not already
 *     consumed (single-use enforced by partial unique index + UPDATE/SET).
 *  2. If a step-up binding is expected: challenge.step_up_challenge_id and
 *     challenge.action_type must match, and binding_hash must equal the
 *     recomputed canonical hash. Replay across pending payments is impossible.
 *  3. clientDataJSON: type=webauthn.get, origin == APP_ORIGIN,
 *     challenge == stored challenge.
 *  4. RP ID hash matches WEBAUTHN_RP_ID (authenticator_data[0..32]).
 *  5. userPresent (UP) and userVerified (UV) flags both set.
 *  6. signCount monotonicity vs stored credential (prevents cloning replay).
 *  7. ECDSA-P256 signature over (authenticator_data || SHA-256(clientDataJSON)).
 *  8. On success: stamp consumed_at, bump credential.sign_count + last_used_at.
 *
 * Never logs raw assertions, challenges, signatures, or credential payloads.
 */
export async function verifyWebAuthnAssertion(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  userId: string,
  body: Record<string, unknown>,
  options: WebAuthnAssertionOptions = {}
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const challengeId = String(body.challenge_id ?? '');
  const credentialId = String(body.credential_id ?? '');
  const clientDataJSONb64 = String(body.client_data_json ?? '');
  const authDataB64 = String(body.authenticator_data ?? '');
  const signatureB64 = String(body.signature ?? '');

  if (!challengeId || !credentialId || !clientDataJSONb64 || !authDataB64 || !signatureB64) {
    return { ok: false, reason: 'biometric_fields_missing' };
  }

  const { data: challengeRow, error: challengeErr } = await supabaseAdmin
    .from('webauthn_challenges')
    .select('id, challenge, expires_at, action_type, step_up_challenge_id, binding_hash, consumed_at')
    .eq('id', challengeId)
    .eq('user_id', userId)
    .single();

  if (challengeErr || !challengeRow) return { ok: false, reason: 'biometric_challenge_invalid' };
  if (challengeRow.consumed_at) return { ok: false, reason: 'biometric_challenge_already_used' };

  if (new Date(challengeRow.expires_at) < new Date()) {
    await supabaseAdmin
      .from('webauthn_challenges')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', challengeId)
      .is('consumed_at', null);
    return { ok: false, reason: 'biometric_challenge_expired' };
  }

  // ── Step-up + action binding enforcement ────────────────────────────────
  // If the caller expects this assertion to satisfy a specific step-up, the
  // challenge MUST have been minted for that step-up, with matching action and
  // binding_hash. This is the transaction-signing guarantee — even a fully
  // compromised frontend cannot redirect an assertion to a different payment.
  if (options.expectedStepUpChallengeId !== undefined && options.expectedStepUpChallengeId !== null) {
    if (challengeRow.step_up_challenge_id !== options.expectedStepUpChallengeId) {
      return { ok: false, reason: 'biometric_challenge_step_up_mismatch' };
    }
  } else if (challengeRow.step_up_challenge_id) {
    // Anyone calling verifyWebAuthnAssertion WITHOUT an expected step-up id
    // must not consume a step-up-bound challenge. (Defense in depth: callers
    // such as set-pin/login can't use a payment challenge by accident.)
    return { ok: false, reason: 'biometric_challenge_requires_step_up' };
  }

  if (options.expectedActionType) {
    if (challengeRow.action_type !== options.expectedActionType) {
      return { ok: false, reason: 'biometric_challenge_action_mismatch' };
    }
    const expectedBindingHash = await computeWebAuthnBindingHash({
      actionType: options.expectedActionType,
      stepUpChallengeId: options.expectedStepUpChallengeId ?? null,
      pendingPaymentId: options.expectedPendingPaymentId ?? null,
      amountMinor: options.expectedAmountMinor ?? null,
      recipientSafe: options.expectedRecipientSafe ?? null,
    });
    if ((challengeRow.binding_hash || '') !== expectedBindingHash) {
      return { ok: false, reason: 'biometric_challenge_binding_mismatch' };
    }
  }

  // Mark consumed BEFORE running heavy crypto so a single network call cannot
  // be replayed: the partial unique index (consumed_at IS NULL) means only one
  // UPDATE wins. Two concurrent callers cannot both succeed.
  const { data: consumed, error: consumeErr } = await supabaseAdmin
    .from('webauthn_challenges')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', challengeId)
    .is('consumed_at', null)
    .select('id')
    .maybeSingle();

  if (consumeErr || !consumed) {
    return { ok: false, reason: 'biometric_challenge_already_used' };
  }

  const config = resolveWebAuthnConfig();
  if (!config.ok) return { ok: false, reason: config.error };

  const clientData = validateWebAuthnClientData({
    clientDataJSONb64,
    expectedType: 'webauthn.get',
    expectedChallenge: challengeRow.challenge,
    appOrigin: config.appOrigin,
  });
  if (!clientData.ok) return { ok: false, reason: clientData.error };

  const authDataBytes = base64ToUint8Array(authDataB64);
  if (authDataBytes.length < 37) return { ok: false, reason: 'biometric_auth_data_short' };

  const rpIdHashFromAuth = authDataBytes.slice(0, 32);
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.rpId))
  );
  if (!rpIdHashFromAuth.every((b, i) => b === expectedRpIdHash[i])) {
    return { ok: false, reason: 'biometric_rpid_mismatch' };
  }

  const flags = authDataBytes[32];
  if ((flags & 0x01) === 0 || (flags & 0x04) === 0) {
    return { ok: false, reason: 'biometric_flags_invalid' };
  }

  const signCount =
    (authDataBytes[33] << 24) |
    (authDataBytes[34] << 16) |
    (authDataBytes[35] << 8) |
    authDataBytes[36];

  const { data: cred, error: credErr } = await supabaseAdmin
    .from('webauthn_credentials')
    .select('id, user_id, public_key_spki, sign_count')
    .eq('credential_id', credentialId)
    .eq('user_id', userId)
    .single();

  if (credErr || !cred) return { ok: false, reason: 'biometric_credential_not_found' };
  // The query is already user-scoped, but defense-in-depth: credentials are
  // never to be cross-used between users even if a row somehow leaks an id.
  if (cred.user_id !== userId) return { ok: false, reason: 'biometric_credential_owner_mismatch' };
  if (signCount !== 0 && signCount <= cred.sign_count) {
    return { ok: false, reason: 'biometric_replay_detected' };
  }

  try {
    const spkiBytes = base64ToUint8Array(cred.public_key_spki);
    const publicKey = await crypto.subtle.importKey(
      'spki',
      spkiBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    const clientDataJsonBytes = base64ToUint8Array(clientDataJSONb64);
    const clientDataHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJsonBytes));
    const verificationData = new Uint8Array(authDataBytes.byteLength + clientDataHash.byteLength);
    verificationData.set(authDataBytes, 0);
    verificationData.set(clientDataHash, authDataBytes.byteLength);
    const sigBytes = base64ToUint8Array(signatureB64);
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: { name: 'SHA-256' } },
      publicKey,
      derToP1363(sigBytes),
      verificationData
    );
    if (!valid) return { ok: false, reason: 'biometric_signature_invalid' };
  } catch {
    return { ok: false, reason: 'biometric_signature_failed' };
  }

  await supabaseAdmin
    .from('webauthn_credentials')
    .update({ sign_count: signCount, last_used_at: new Date().toISOString() })
    .eq('id', cred.id);

  return { ok: true };
}
