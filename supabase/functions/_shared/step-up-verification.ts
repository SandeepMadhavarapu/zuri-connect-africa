import {
  getPinPepper,
  normalizePin,
  verifyPinWithPepper,
} from './pin-crypto.ts';
import { checkRateLimit } from './rate-limit.ts';
import {
  hashOtpWithPepper,
  normalizeOtpPurpose,
  type OtpPurpose,
} from './otp-crypto.ts';
import { verifyWebAuthnAssertion } from './webauthn-verify.ts';

export const NON_RESUMABLE_PAYMENT_STATUSES = new Set([
  'succeeded',
  'completed',
  'confirmed',
  'settled',
  'failed',
  'cancelled',
  'canceled',
  'timeout',
  'review_required',
  'reversed',
]);

export function canResumePendingPayment(status: string): boolean {
  return String(status || '').toLowerCase() === 'step_up_required';
}

export function challengeMatchesPayment(
  challenge: { pending_payment_id: string; user_id: string },
  pending: { id: string; user_id: string; amount: number | string; to_phone: string; from_phone: string },
  body: Record<string, unknown>
): boolean {
  if (challenge.pending_payment_id !== pending.id) return false;
  if (challenge.user_id !== pending.user_id) return false;
  if (body.pending_payment_id && String(body.pending_payment_id) !== String(pending.id)) return false;
  if (body.amount !== undefined && Number(body.amount) !== Number(pending.amount)) return false;
  if (body.to_phone !== undefined && String(body.to_phone) !== String(pending.to_phone)) return false;
  if (body.from_phone !== undefined && String(body.from_phone) !== String(pending.from_phone)) return false;
  return true;
}

export function isChallengeExpired(expiresAt: string, now = new Date()): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}

/**
 * Atomic, single-use OTP verification used by step-up and PIN flows.
 *
 * Differences from the old SHA-256 select-then-delete path:
 *   * Hash is HMAC-SHA256(OTP_PEPPER, `${purpose}:${phone}:${otp}`), so an OTP
 *     minted for `verification` cannot be replayed against `step_up`, and a
 *     leaked otp_hash row is useless without the deploy-time pepper.
 *   * Verification happens through the `consume_otp` Postgres RPC, which
 *     locks the row `FOR UPDATE SKIP LOCKED` and stamps `consumed_at` in a
 *     single transaction — two concurrent callers can never both succeed.
 *   * Failed attempts increment `attempts` server-side; the 3-strike lock is
 *     enforced inside the RPC.
 *   * The raw OTP never leaves this function and is not logged.
 *
 * Missing OTP_PEPPER fails closed with `otp_service_unavailable` — never
 * silently degrades to an unsalted hash.
 */
export async function verifyOtpAgainstRecord(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
  phone: string,
  otp: string,
  purpose: OtpPurpose | string = 'step_up'
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const trimmedOtp = String(otp ?? '').trim();
  const trimmedPhone = String(phone ?? '').trim();
  if (!trimmedOtp || !trimmedPhone) {
    return { ok: false, reason: 'otp_required' };
  }
  const safePurpose = normalizeOtpPurpose(purpose);

  let candidateHash: string;
  try {
    candidateHash = await hashOtpWithPepper(trimmedOtp, trimmedPhone, safePurpose);
  } catch {
    return { ok: false, reason: 'otp_service_unavailable' };
  }

  const { data: rpcData, error: rpcErr } = await supabaseAdmin.rpc('consume_otp', {
    p_phone: trimmedPhone,
    p_purpose: safePurpose,
    p_hash: candidateHash,
    p_max_attempts: 3,
    p_user_id: null,
  });

  if (rpcErr) {
    return { ok: false, reason: 'otp_service_unavailable' };
  }

  const row = Array.isArray(rpcData) ? rpcData[0] : rpcData;
  const outcome = String(row?.outcome ?? 'not_found');

  if (outcome === 'consumed') return { ok: true };
  if (outcome === 'expired') return { ok: false, reason: 'otp_expired' };
  if (outcome === 'locked') return { ok: false, reason: 'otp_locked' };
  if (outcome === 'already_consumed') return { ok: false, reason: 'otp_already_used' };
  if (outcome === 'invalid') return { ok: false, reason: 'otp_invalid' };
  if (outcome === 'invalid_input') return { ok: false, reason: 'otp_invalid' };
  return { ok: false, reason: 'otp_not_found' };
}

export async function verifyUserPinForStepUp(
  supabaseAdmin: any,
  userId: string,
  pin: unknown,
  onFailure?: (reason: string) => Promise<void>
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const normalized = normalizePin(pin);
  if (!normalized) {
    await onFailure?.('pin_invalid_format');
    return { ok: false, reason: 'pin_invalid_format' };
  }

  const limit = await checkRateLimit(
    supabaseAdmin,
    userId,
    'user',
    'complete-step-up-pin',
    5,
    600,
    1800
  );
  if (!limit.allowed) {
    await onFailure?.('pin_rate_limited');
    return { ok: false, reason: 'pin_rate_limited' };
  }

  const { data: pinRow } = await supabaseAdmin
    .from('pin_hash_metadata')
    .select('pin_hash, hash_version')
    .eq('user_id', userId)
    .maybeSingle();

  if (!pinRow?.pin_hash) {
    await onFailure?.('pin_not_enrolled');
    return { ok: false, reason: 'pin_not_enrolled' };
  }

  let pepper: string;
  try {
    pepper = getPinPepper();
  } catch {
    await onFailure?.('pin_verification_unavailable');
    return { ok: false, reason: 'pin_verification_unavailable' };
  }

  const valid = await verifyPinWithPepper(
    normalized,
    pinRow.pin_hash,
    pepper,
    pinRow.hash_version
  );

  if (!valid) {
    await onFailure?.('pin_invalid');
    return { ok: false, reason: 'pin_invalid' };
  }

  return { ok: true };
}

export { verifyWebAuthnAssertion };
