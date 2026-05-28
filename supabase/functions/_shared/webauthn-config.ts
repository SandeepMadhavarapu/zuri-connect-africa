export type WebAuthnConfig =
  | { ok: true; appOrigin: string; rpId: string; rpName: string; originHost: string }
  | { ok: false; error: string };

type EnvGetter = (key: string) => string | undefined | null;

export function getRuntimeEnv(key: string): string {
  const deno = (globalThis as unknown as { Deno?: { env?: { get?: (name: string) => string | undefined } } }).Deno;
  if (deno?.env?.get) return deno.env.get(key) ?? '';
  return '';
}

export function resolveWebAuthnConfig(envGet: EnvGetter = getRuntimeEnv): WebAuthnConfig {
  const appOrigin = String(envGet('APP_ORIGIN') ?? '').trim().replace(/\/$/, '');
  const rpId = String(envGet('WEBAUTHN_RP_ID') ?? '').trim().toLowerCase();
  const rpName = String(envGet('WEBAUTHN_RP_NAME') ?? 'Zuri Connect Africa').trim() || 'Zuri Connect Africa';

  if (!appOrigin) return { ok: false, error: 'webauthn_app_origin_missing' };
  if (!rpId) return { ok: false, error: 'webauthn_rp_id_missing' };

  let originUrl: URL;
  try {
    originUrl = new URL(appOrigin);
  } catch {
    return { ok: false, error: 'webauthn_app_origin_invalid' };
  }

  const originHost = originUrl.hostname.toLowerCase();
  const localhost = originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1';
  if (originUrl.protocol !== 'https:' && !(originUrl.protocol === 'http:' && localhost)) {
    return { ok: false, error: 'webauthn_origin_insecure' };
  }

  if (rpId !== originHost && !originHost.endsWith(`.${rpId}`)) {
    return { ok: false, error: 'webauthn_rp_id_origin_mismatch' };
  }

  return { ok: true, appOrigin, rpId, rpName, originHost };
}

/**
 * Decode a base64 OR base64url string into raw bytes.
 *
 * The frontend serializes WebAuthn ArrayBuffers as base64url (URL-safe, no padding)
 * per the WebAuthn JSON conventions (W3C webauthn-3). Legacy clients may still send
 * standard base64. We accept both so existing stored credentials and new payloads
 * decode without weakening validation downstream.
 */
export function base64ToUint8Array(b64: string): Uint8Array {
  const raw = String(b64 ?? '').trim();
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = padLen ? normalized + '='.repeat(padLen) : normalized;
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function uint8ArrayToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function parseWebAuthnClientData(clientDataJSONb64: string): { ok: true; data: { type?: string; challenge?: string; origin?: string } } | { ok: false; error: string } {
  try {
    const clientDataBytes = base64ToUint8Array(clientDataJSONb64);
    return { ok: true, data: JSON.parse(new TextDecoder().decode(clientDataBytes)) };
  } catch {
    return { ok: false, error: 'webauthn_client_data_invalid' };
  }
}

export function validateWebAuthnClientData(input: {
  clientDataJSONb64: string;
  expectedType: 'webauthn.create' | 'webauthn.get';
  expectedChallenge: string;
  appOrigin: string;
}): { ok: true; data: { type?: string; challenge?: string; origin?: string } } | { ok: false; error: string } {
  const parsed = parseWebAuthnClientData(input.clientDataJSONb64);
  if (!parsed.ok) return parsed;
  if (parsed.data.type !== input.expectedType) return { ok: false, error: 'webauthn_wrong_ceremony' };
  if (parsed.data.origin !== input.appOrigin) return { ok: false, error: 'webauthn_origin_mismatch' };
  if (parsed.data.challenge !== input.expectedChallenge) return { ok: false, error: 'webauthn_challenge_mismatch' };
  return parsed;
}

// ── Step-up action binding ────────────────────────────────────────────────────
//
// A WebAuthn step-up challenge is bound to (action_type, step_up_challenge_id,
// pending_payment_id, amount_minor, recipient_safe) by SHA-256 hashing the
// canonical JSON of these fields. The hash is stored on issue and re-computed
// on consume, so a frontend cannot reuse an assertion for a different action,
// amount, or recipient — even if it controls the network request.

export type WebAuthnActionType =
  | 'enrollment'
  | 'authentication'
  | 'payment_send'
  | 'payment_paybill'
  | 'payment_airtime'
  | 'payment_bundle'
  | 'pin_change'
  | 'pin_setup'
  | 'pin_reset'
  | 'security_change';

export const WEBAUTHN_ACTION_TYPES: readonly WebAuthnActionType[] = Object.freeze([
  'enrollment',
  'authentication',
  'payment_send',
  'payment_paybill',
  'payment_airtime',
  'payment_bundle',
  'pin_change',
  'pin_setup',
  'pin_reset',
  'security_change',
]);

export const PAYMENT_ACTION_TYPES: readonly WebAuthnActionType[] = Object.freeze([
  'payment_send',
  'payment_paybill',
  'payment_airtime',
  'payment_bundle',
]);

export function isWebAuthnActionType(value: unknown): value is WebAuthnActionType {
  return typeof value === 'string' && (WEBAUTHN_ACTION_TYPES as readonly string[]).includes(value);
}

export type WebAuthnBindingInput = {
  actionType: WebAuthnActionType;
  stepUpChallengeId?: string | null;
  pendingPaymentId?: string | null;
  amountMinor?: number | null;
  recipientSafe?: string | null;
};

function canonicalRecipient(input: string | null | undefined): string {
  // Recipient identifiers are normalized for hashing (lowercase, trimmed). We
  // never include the un-masked recipient in any log line; the hash itself is
  // not reversible without the canonical input the server already holds.
  return String(input ?? '').trim().toLowerCase();
}

export async function computeWebAuthnBindingHash(input: WebAuthnBindingInput): Promise<string> {
  const canonical = JSON.stringify({
    a: input.actionType,
    s: input.stepUpChallengeId ?? null,
    p: input.pendingPaymentId ?? null,
    m: typeof input.amountMinor === 'number' && Number.isFinite(input.amountMinor)
      ? Math.trunc(input.amountMinor)
      : null,
    r: canonicalRecipient(input.recipientSafe),
  });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return uint8ArrayToBase64url(new Uint8Array(buf));
}
