/**
 * verify-biometric — Supabase Edge Function
 *
 * Three actions via POST body { action }:
 *   get_challenge — generate a server-side challenge (single-use, 5-min TTL)
 *   register      — store a new credential after browser-side enrollment
 *   verify        — full WebAuthn assertion verification
 *
 * All actions require a valid Supabase JWT (Authorization: Bearer <token>).
 * The verify action performs:
 *   1. Challenge consumption (single-use, expiry enforced)
 *   2. clientDataJSON: type=webauthn.get, origin, challenge
 *   3. rpIdHash: SHA-256(rpId) vs authenticatorData[0:32]
 *   4. Flags: userPresent (bit 0) and userVerified (bit 2) must both be set
 *   5. signCount monotonicity (prevents credential cloning / replay)
 *   6. Signature: ECDSA-P256 over (authenticatorData || SHA-256(clientDataJSON))
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  base64ToUint8Array,
  computeWebAuthnBindingHash,
  isWebAuthnActionType,
  resolveWebAuthnConfig,
  uint8ArrayToBase64url,
  validateWebAuthnClientData,
  type WebAuthnActionType,
} from '../_shared/webauthn-config.ts';
import { getAuthDataFromAttestationObject } from '../_shared/webauthn-attestation.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Encoding helpers ──────────────────────────────────────────────────────────

// ── DER → IEEE P1363 for SubtleCrypto ECDSA verify ───────────────────────────
// WebAuthn ECDSA signatures arrive as DER-encoded ASN.1 SEQUENCE { INTEGER r, INTEGER s }.
// SubtleCrypto expects raw 64-byte P1363 format: r (32 bytes) || s (32 bytes).

function derToP1363(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('DER: not a SEQUENCE');

  // Skip SEQUENCE tag and length (handle both short- and long-form lengths)
  let offset = der[1] >= 0x80 ? 2 + (der[1] & 0x7f) : 2;

  // Parse r INTEGER
  if (der[offset] !== 0x02) throw new Error('DER: r is not INTEGER');
  offset++;
  const rLen = der[offset++];
  const rBytes = der.slice(offset, offset + rLen);
  offset += rLen;

  // Parse s INTEGER
  if (der[offset] !== 0x02) throw new Error('DER: s is not INTEGER');
  offset++;
  const sLen = der[offset++];
  const sBytes = der.slice(offset, offset + sLen);

  // Zero-pad / strip leading sign byte to exactly 32 bytes each
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

// ── Main handler ──────────────────────────────────────────────────────────────

async function verifyRpIdHash(authData: Uint8Array, rpId: string): Promise<boolean> {
  if (authData.length < 37) return false;
  const rpIdHashFromAuth = authData.slice(0, 32);
  const expectedRpIdHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId))
  );
  return rpIdHashFromAuth.every((b, i) => b === expectedRpIdHash[i]);
}

function hasUserPresentAndVerifiedFlags(authData: Uint8Array): boolean {
  if (authData.length < 37) return false;
  const flags = authData[32];
  return (flags & 0x01) !== 0 && (flags & 0x04) !== 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  const envCheck = requireFunctionEnv({
    functionName: 'verify-biometric',
    required:       ['APP_ORIGIN', 'WEBAUTHN_RP_ID', 'WEBAUTHN_RP_NAME'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase    = createClient(supabaseUrl, serviceKey);

  // All actions require a valid authenticated session.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return Response.json({ error: 'missing_authorization' }, { status: 401, headers: corsHeaders });
  }
  const { data: userRes, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !userRes.user) {
    return Response.json({ error: 'invalid_token' }, { status: 401, headers: corsHeaders });
  }
  const userId = userRes.user.id;

  const body   = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body?.action ?? '');
  const webAuthnConfig = resolveWebAuthnConfig();
  if (!webAuthnConfig.ok && ['get_registration_options', 'get_challenge', 'register', 'verify'].includes(action)) {
    console.warn('[verify-biometric] config_error', webAuthnConfig.error);
    return Response.json({ error: webAuthnConfig.error }, { status: 500, headers: corsHeaders });
  }

  // ── get_challenge: generate a server-side challenge ───────────────────────
  if (action === 'get_registration_options') {
    const config = webAuthnConfig.ok ? webAuthnConfig : null;
    if (!config) return Response.json({ error: 'webauthn_config_missing' }, { status: 500, headers: corsHeaders });

    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challengeB64url = uint8ArrayToBase64url(challengeBytes);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { data: row, error: insertErr } = await supabase
      .from('webauthn_challenges')
      .insert({
        user_id: userId,
        challenge: challengeB64url,
        expires_at: expiresAt,
        action_type: 'enrollment',
      })
      .select('id')
      .single();

    if (insertErr || !row) {
      return Response.json({ error: 'challenge_create_failed' }, { status: 500, headers: corsHeaders });
    }

    return Response.json({
      challenge: challengeB64url,
      challenge_id: row.id,
      rp_id: config.rpId,
      rp_name: config.rpName,
    }, { headers: corsHeaders });
  }

  if (action === 'get_challenge') {
    // Legacy generic challenge — used only for login/restore biometric flows.
    // Sensitive financial actions MUST use `get_step_up_assertion_options` so
    // the challenge is bound to a specific step-up + action + amount + recipient.
    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challengeB64url = uint8ArrayToBase64url(challengeBytes);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const { data: row, error: insertErr } = await supabase
      .from('webauthn_challenges')
      .insert({
        user_id: userId,
        challenge: challengeB64url,
        expires_at: expiresAt,
        action_type: 'authentication',
      })
      .select('id')
      .single();

    if (insertErr || !row) {
      return Response.json({ error: 'challenge_create_failed' }, { status: 500, headers: corsHeaders });
    }
    return Response.json({ challenge: challengeB64url, challenge_id: row.id }, { headers: corsHeaders });
  }

  // ── get_step_up_assertion_options ────────────────────────────────────────
  // Action-bound assertion challenge: ties the WebAuthn ceremony to one
  // specific step_up_challenges row, action_type, amount, and recipient. The
  // resulting binding_hash is re-checked on consume by complete-step-up /
  // set-pin so a frontend cannot reuse the assertion to authorize a different
  // sensitive action than the modal claims.
  if (action === 'get_step_up_assertion_options') {
    const stepUpChallengeId = String(body?.step_up_challenge_id ?? '').trim();
    const actionTypeRaw = String(body?.action_type ?? '').trim();
    const bindingRaw = (body?.binding && typeof body.binding === 'object') ? body.binding as Record<string, unknown> : {};

    if (!stepUpChallengeId) {
      return Response.json({ error: 'step_up_challenge_required' }, { status: 400, headers: corsHeaders });
    }
    if (!isWebAuthnActionType(actionTypeRaw)) {
      return Response.json({ error: 'invalid_action_type' }, { status: 400, headers: corsHeaders });
    }
    const actionType: WebAuthnActionType = actionTypeRaw;

    // The step-up challenge must belong to this user, be still pending, of type
    // biometric, and not expired. Anything else is a misuse — fail closed.
    const { data: stepUp, error: stepUpErr } = await supabase
      .from('step_up_challenges')
      .select('id, user_id, pending_payment_id, challenge_type, status, expires_at')
      .eq('id', stepUpChallengeId)
      .eq('user_id', userId)
      .maybeSingle();

    if (stepUpErr || !stepUp) {
      return Response.json({ error: 'step_up_challenge_not_found' }, { status: 404, headers: corsHeaders });
    }
    if (stepUp.challenge_type !== 'biometric') {
      return Response.json({ error: 'step_up_challenge_not_biometric' }, { status: 403, headers: corsHeaders });
    }
    if (stepUp.status !== 'pending') {
      return Response.json({ error: 'step_up_challenge_not_pending' }, { status: 409, headers: corsHeaders });
    }
    if (new Date(stepUp.expires_at) < new Date()) {
      return Response.json({ error: 'step_up_challenge_expired' }, { status: 410, headers: corsHeaders });
    }

    // The frontend supplies the binding *intent* (amount, recipient). For
    // payments we cross-check it against the authoritative pending_payments
    // row so a malicious client cannot mint a challenge with different inputs
    // than the actual payment. Pending payment is required for payment_*.
    let pendingPaymentId: string | null = null;
    let amountMinor: number | null = null;
    let recipientSafe: string | null = null;

    if (actionType.startsWith('payment_')) {
      if (!stepUp.pending_payment_id) {
        return Response.json({ error: 'pending_payment_required' }, { status: 400, headers: corsHeaders });
      }
      const { data: pending, error: pendingErr } = await supabase
        .from('pending_payments')
        .select('id, user_id, amount, to_phone, status')
        .eq('id', stepUp.pending_payment_id)
        .eq('user_id', userId)
        .maybeSingle();
      if (pendingErr || !pending) {
        return Response.json({ error: 'pending_payment_not_found' }, { status: 404, headers: corsHeaders });
      }
      if (String(pending.status).toLowerCase() !== 'step_up_required') {
        return Response.json({ error: 'pending_payment_not_resumable' }, { status: 409, headers: corsHeaders });
      }
      pendingPaymentId = pending.id;
      amountMinor = Math.round(Number(pending.amount) * 100);
      // recipient_safe is hashed in the binding; only the masked tail is
      // returned to the client. We never echo full account numbers.
      recipientSafe = String(pending.to_phone || '');
    } else if (actionType === 'pin_change' || actionType === 'pin_setup' || actionType === 'pin_reset' || actionType === 'security_change') {
      // Non-payment sensitive actions bind to the step-up id only.
      const optionalAmount = Number(bindingRaw?.amount_minor);
      amountMinor = Number.isFinite(optionalAmount) ? Math.round(optionalAmount) : null;
      recipientSafe = bindingRaw?.recipient_safe ? String(bindingRaw.recipient_safe) : null;
    } else {
      return Response.json({ error: 'action_type_not_supported_for_step_up' }, { status: 400, headers: corsHeaders });
    }

    const bindingHash = await computeWebAuthnBindingHash({
      actionType,
      stepUpChallengeId,
      pendingPaymentId,
      amountMinor,
      recipientSafe,
    });

    // Each step_up_challenge has at most one open WebAuthn challenge at a time
    // (partial unique index uq_webauthn_challenges_step_up_open). Mark any
    // previously-issued but un-consumed challenge for this step-up as expired
    // before creating the new one so the user can retry safely.
    await supabase
      .from('webauthn_challenges')
      .update({ consumed_at: new Date().toISOString() })
      .eq('step_up_challenge_id', stepUpChallengeId)
      .is('consumed_at', null);

    const challengeBytes = new Uint8Array(32);
    crypto.getRandomValues(challengeBytes);
    const challengeB64url = uint8ArrayToBase64url(challengeBytes);
    // Shorter TTL than the legacy 5-min generic challenge — keeps the window
    // tight enough that even a leaked link cannot be replayed days later.
    const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

    const { data: row, error: insertErr } = await supabase
      .from('webauthn_challenges')
      .insert({
        user_id: userId,
        challenge: challengeB64url,
        expires_at: expiresAt,
        action_type: actionType,
        step_up_challenge_id: stepUpChallengeId,
        binding_hash: bindingHash,
      })
      .select('id')
      .single();

    if (insertErr || !row) {
      console.warn('[verify-biometric] step_up_challenge_insert_failed', insertErr?.code || 'unknown');
      return Response.json({ error: 'challenge_create_failed' }, { status: 500, headers: corsHeaders });
    }

    // Fetch the user's enrolled credentials so the browser can populate
    // allowCredentials. Only credential_id is exposed — never public keys.
    const { data: creds } = await supabase
      .from('webauthn_credentials')
      .select('credential_id')
      .eq('user_id', userId);

    const allowCredentials = (creds || []).map((c) => ({ id: c.credential_id, type: 'public-key', transports: ['internal'] }));
    if (allowCredentials.length === 0) {
      return Response.json({ error: 'no_credentials_enrolled' }, { status: 409, headers: corsHeaders });
    }

    return Response.json({
      challenge: challengeB64url,
      challenge_id: row.id,
      rp_id: webAuthnConfig.ok ? webAuthnConfig.rpId : '',
      action_type: actionType,
      step_up_challenge_id: stepUpChallengeId,
      // The client must echo the same masked summary back into its UI. We do
      // not leak full to_phone or pending_payment_id beyond what the client
      // already has from initiate-payment.
      allow_credentials: allowCredentials,
      expires_at: expiresAt,
    }, { headers: corsHeaders });
  }

  // ── register: store server-side credential after browser enrollment ────────
  if (action === 'register') {
    const credentialId   = String(body?.credential_id   ?? '');
    const publicKeySpki  = String(body?.public_key_spki  ?? '');
    const algorithm      = Number(body?.algorithm        ?? -7);
    const challengeId    = String(body?.challenge_id     ?? '');
    const clientDataJSONb64 = String(body?.client_data_json ?? '');
    const attestationObjectB64 = String(body?.attestation_object ?? '');

    if (!credentialId || !publicKeySpki || !challengeId || !clientDataJSONb64 || !attestationObjectB64) {
      return Response.json({ error: 'registration_fields_missing' }, { status: 400, headers: corsHeaders });
    }

    const config = webAuthnConfig.ok ? webAuthnConfig : null;
    if (!config) return Response.json({ error: 'webauthn_config_missing' }, { status: 500, headers: corsHeaders });

    const { data: existingCred } = await supabase
      .from('webauthn_credentials')
      .select('id')
      .eq('credential_id', credentialId)
      .maybeSingle();

    if (existingCred) {
      return Response.json({ error: 'duplicate_credential' }, { status: 409, headers: corsHeaders });
    }

    const { data: challengeRow, error: challengeErr } = await supabase
      .from('webauthn_challenges')
      .select('id, challenge, expires_at, consumed_at, action_type, step_up_challenge_id')
      .eq('id', challengeId)
      .eq('user_id', userId)
      .single();

    if (challengeErr || !challengeRow) {
      return Response.json({ error: 'invalid_challenge' }, { status: 403, headers: corsHeaders });
    }
    if (challengeRow.consumed_at) {
      return Response.json({ error: 'challenge_already_used' }, { status: 403, headers: corsHeaders });
    }
    if (challengeRow.step_up_challenge_id) {
      return Response.json({ error: 'challenge_requires_step_up_completion' }, { status: 403, headers: corsHeaders });
    }
    if (challengeRow.action_type && challengeRow.action_type !== 'enrollment') {
      return Response.json({ error: 'invalid_challenge' }, { status: 403, headers: corsHeaders });
    }
    if (new Date(challengeRow.expires_at) < new Date()) {
      await supabase
        .from('webauthn_challenges')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', challengeId)
        .is('consumed_at', null);
      return Response.json({ error: 'challenge_expired' }, { status: 403, headers: corsHeaders });
    }
    const { data: consumedReg, error: consumeRegErr } = await supabase
      .from('webauthn_challenges')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', challengeId)
      .is('consumed_at', null)
      .select('id')
      .maybeSingle();
    if (consumeRegErr || !consumedReg) {
      return Response.json({ error: 'challenge_already_used' }, { status: 403, headers: corsHeaders });
    }

    const clientData = validateWebAuthnClientData({
      clientDataJSONb64,
      expectedType: 'webauthn.create',
      expectedChallenge: challengeRow.challenge,
      appOrigin: config.appOrigin,
    });
    if (!clientData.ok) {
      return Response.json({ error: clientData.error }, { status: 403, headers: corsHeaders });
    }

    let authData: Uint8Array | null = null;
    try {
      authData = getAuthDataFromAttestationObject(attestationObjectB64);
    } catch (err) {
      // NEVER log raw attestation bytes or clientDataJSON — only the error code class.
      console.warn('[verify-biometric] attestation_object_invalid', String((err as Error)?.message ?? 'parse_failed'));
      return Response.json({ error: 'attestation_object_invalid' }, { status: 400, headers: corsHeaders });
    }
    if (!authData) {
      return Response.json({ error: 'attestation_auth_data_missing' }, { status: 400, headers: corsHeaders });
    }
    if (!(await verifyRpIdHash(authData, config.rpId))) {
      return Response.json({ error: 'rpid_hash_mismatch' }, { status: 403, headers: corsHeaders });
    }
    if (!hasUserPresentAndVerifiedFlags(authData)) {
      return Response.json({ error: 'user_presence_or_verification_not_set' }, { status: 403, headers: corsHeaders });
    }

    // Validate the key is importable before persisting it.
    try {
      const spkiBytes = base64ToUint8Array(publicKeySpki);
      await crypto.subtle.importKey(
        'spki', spkiBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['verify']
      );
    } catch {
      return Response.json({ error: 'invalid_public_key' }, { status: 400, headers: corsHeaders });
    }

    const { error: storeErr } = await supabase
      .from('webauthn_credentials')
      .insert({ user_id: userId, credential_id: credentialId, public_key_spki: publicKeySpki, algorithm, sign_count: 0 });

    if (storeErr) {
      const duplicate = String(storeErr.code || '') === '23505' || /duplicate|unique/i.test(String(storeErr.message || ''));
      return Response.json(
        { error: duplicate ? 'duplicate_credential' : 'credential_store_failed' },
        { status: duplicate ? 409 : 500, headers: corsHeaders }
      );
    }
    return Response.json({ ok: true }, { headers: corsHeaders });
  }

  // ── verify: full WebAuthn assertion verification ──────────────────────────
  if (action === 'verify') {
    const challengeId       = String(body?.challenge_id       ?? '');
    const credentialId      = String(body?.credential_id      ?? '');
    const clientDataJSONb64 = String(body?.client_data_json   ?? '');
    const authDataB64       = String(body?.authenticator_data ?? '');
    const signatureB64      = String(body?.signature          ?? '');

    if (!challengeId || !credentialId || !clientDataJSONb64 || !authDataB64 || !signatureB64) {
      return Response.json({ error: 'Missing required assertion fields' }, { status: 400, headers: corsHeaders });
    }

    // 1. Consume the challenge (single-use, action-unbound only) ────────────
    // The standalone `verify` action is for login/restore biometric flows. It
    // refuses challenges that were minted with a step_up_challenge_id, since
    // those must be consumed by complete-step-up (which checks binding).
    const { data: challengeRow, error: challengeErr } = await supabase
      .from('webauthn_challenges')
      .select('id, challenge, expires_at, step_up_challenge_id, consumed_at, action_type')
      .eq('id', challengeId)
      .eq('user_id', userId)
      .single();

    if (challengeErr || !challengeRow) {
      return Response.json({ error: 'invalid_challenge' }, { status: 403, headers: corsHeaders });
    }
    if (challengeRow.consumed_at) {
      return Response.json({ error: 'challenge_already_used' }, { status: 403, headers: corsHeaders });
    }
    if (challengeRow.step_up_challenge_id) {
      // Step-up bound challenges must NOT be consumed by the generic verify
      // endpoint — that would bypass amount/recipient binding enforcement.
      return Response.json({ error: 'challenge_requires_step_up_completion' }, { status: 403, headers: corsHeaders });
    }
    if (new Date(challengeRow.expires_at) < new Date()) {
      await supabase
        .from('webauthn_challenges')
        .update({ consumed_at: new Date().toISOString() })
        .eq('id', challengeId)
        .is('consumed_at', null);
      return Response.json({ error: 'challenge_expired' }, { status: 403, headers: corsHeaders });
    }
    // Stamp consumed_at BEFORE the heavy crypto work so single-use is enforced
    // even on subsequent failures. The partial unique index guarantees only
    // one transaction wins this update; concurrent calls collide and fail.
    const { data: consumedRow, error: consumeErr } = await supabase
      .from('webauthn_challenges')
      .update({ consumed_at: new Date().toISOString() })
      .eq('id', challengeId)
      .is('consumed_at', null)
      .select('id')
      .maybeSingle();
    if (consumeErr || !consumedRow) {
      return Response.json({ error: 'challenge_already_used' }, { status: 403, headers: corsHeaders });
    }

    // 2. Parse and validate clientDataJSON ───────────────────────────────────
    const config = webAuthnConfig.ok ? webAuthnConfig : null;
    if (!config) return Response.json({ error: 'webauthn_config_missing' }, { status: 500, headers: corsHeaders });

    const clientData = validateWebAuthnClientData({
      clientDataJSONb64,
      expectedType: 'webauthn.get',
      expectedChallenge: challengeRow.challenge,
      appOrigin: config.appOrigin,
    });
    if (!clientData.ok) {
      return Response.json({ error: clientData.error }, { status: 403, headers: corsHeaders });
    }

    // 3. Parse authenticatorData ─────────────────────────────────────────────
    const authDataBytes = base64ToUint8Array(authDataB64);
    if (authDataBytes.length < 37) {
      return Response.json({ error: 'authenticator_data_too_short' }, { status: 403, headers: corsHeaders });
    }

    // 4. Verify rpId hash (bytes 0–31) ───────────────────────────────────────
    if (!(await verifyRpIdHash(authDataBytes, config.rpId))) {
      return Response.json({ error: 'rpid_hash_mismatch' }, { status: 403, headers: corsHeaders });
    }

    // 5. Verify flags (byte 32): UP (bit 0) and UV (bit 2) must be set ───────
    if (!hasUserPresentAndVerifiedFlags(authDataBytes)) {
      return Response.json({ error: 'user_presence_or_verification_not_set' }, { status: 403, headers: corsHeaders });
    }

    // 6. Read signCount (bytes 33–36, big-endian uint32) ─────────────────────
    const signCount =
      (authDataBytes[33] << 24) |
      (authDataBytes[34] << 16) |
      (authDataBytes[35] <<  8) |
       authDataBytes[36];

    // 7. Fetch stored credential ─────────────────────────────────────────────
    const { data: cred, error: credErr } = await supabase
      .from('webauthn_credentials')
      .select('id, public_key_spki, sign_count, algorithm')
      .eq('credential_id', credentialId)
      .eq('user_id', userId)
      .single();

    if (credErr || !cred) {
      return Response.json({ error: 'credential_not_found' }, { status: 403, headers: corsHeaders });
    }

    // 8. signCount monotonicity check ────────────────────────────────────────
    // signCount of 0 means the authenticator does not support counter — skip.
    if (signCount !== 0 && signCount <= cred.sign_count) {
      return Response.json({ error: 'sign_count_replay_detected' }, { status: 403, headers: corsHeaders });
    }

    // 9. Verify cryptographic signature ──────────────────────────────────────
    try {
      const spkiBytes     = base64ToUint8Array(cred.public_key_spki);
      const publicKey     = await crypto.subtle.importKey(
        'spki', spkiBytes,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false, ['verify']
      );

      const clientDataJsonBytes = base64ToUint8Array(clientDataJSONb64);
      const clientDataHash      = new Uint8Array(
        await crypto.subtle.digest('SHA-256', clientDataJsonBytes)
      );

      // Verification data = authenticatorData || SHA-256(clientDataJSON)
      const verificationData = new Uint8Array(authDataBytes.byteLength + clientDataHash.byteLength);
      verificationData.set(authDataBytes, 0);
      verificationData.set(clientDataHash, authDataBytes.byteLength);

      const sigBytes  = base64ToUint8Array(signatureB64);
      const p1363Sig  = derToP1363(sigBytes);

      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        publicKey,
        p1363Sig,
        verificationData
      );

      if (!valid) {
        return Response.json({ error: 'signature_invalid' }, { status: 403, headers: corsHeaders });
      }
    } catch (sigErr) {
      console.error('[verify-biometric] Signature error:', sigErr);
      return Response.json({ error: 'signature_verification_failed' }, { status: 403, headers: corsHeaders });
    }

    // 10. Update signCount ───────────────────────────────────────────────────
    await supabase
      .from('webauthn_credentials')
      .update({ sign_count: signCount, last_used_at: new Date().toISOString() })
      .eq('id', cred.id);

    return Response.json({ ok: true, verified: true }, { headers: corsHeaders });
  }

  return Response.json({ error: 'Unknown action' }, { status: 400, headers: corsHeaders });
});
