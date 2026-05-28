// Production webhook verifier used by webhook-handler/index.ts.
// These are the exact functions that run in production when Daraja calls back
// with a payment confirmation. Extracted here so they can be unit-tested directly.

export const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type WebhookVerificationResult =
  | { valid: true }
  | { valid: false; reason: string };

export async function hmacSha256(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export async function sha256Hex(message: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyWebhookSignature(rawBody: string, signatureHeader: string | null, timestampHeader: string | null, secret: string): Promise<WebhookVerificationResult> {
  if (!signatureHeader) return { valid: false, reason: 'missing_signature' };
  if (!secret) return { valid: false, reason: 'no_secret_configured' };
  if (timestampHeader) {
    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid_timestamp' };
    const tsSec = ts > 1e12 ? Math.floor(ts / 1000) : ts;
    if (Math.abs(Date.now() / 1000 - tsSec) > TIMESTAMP_TOLERANCE_SECONDS) {
      return { valid: false, reason: 'timestamp_expired' };
    }
  }
  const expected = await hmacSha256(secret, timestampHeader ? `${timestampHeader}.${rawBody}` : rawBody);
  const received = signatureHeader.replace(/^sha256=/i, '').trim().toLowerCase();
  return constantTimeEqual(expected, received) ? { valid: true } : { valid: false, reason: 'signature_mismatch' };
}
