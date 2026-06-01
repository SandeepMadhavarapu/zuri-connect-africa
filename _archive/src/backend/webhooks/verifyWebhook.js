/**
 * Zuri Connect Africa - webhook verification primitives
 * Production-style HMAC SHA-256 verification for Daraja callbacks.
 */

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_MS = 30 * 1000;
const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

function textEncode(value) {
  return new TextEncoder().encode(String(value ?? ''));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function normaliseSignature(signature) {
  const raw = String(signature || '').trim();
  if (!raw) return '';
  return raw.startsWith('sha256=') ? raw.slice(7) : raw;
}

function getHeader(headers, name) {
  if (!headers || !name) return null;
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase());

  const lower = name.toLowerCase();
  const match = Object.keys(headers).find(key => key.toLowerCase() === lower);
  return match ? headers[match] : null;
}

function getSecret(explicitSecret) {
  if (explicitSecret) return explicitSecret;

  const env = globalThis?.process?.env || {};
  return env.DARAJA_WEBHOOK_SECRET ||
    env.MPESA_WEBHOOK_SECRET ||
    null;
}

function byteLength(payload) {
  if (payload instanceof ArrayBuffer) return payload.byteLength;
  if (ArrayBuffer.isView(payload)) return payload.byteLength;
  return textEncode(payload).byteLength;
}

function secureEqual(a, b) {
  const left = textEncode(a);
  const right = textEncode(b);
  const max = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;

  for (let i = 0; i < max; i++) {
    diff |= (left[i] || 0) ^ (right[i] || 0);
  }

  return diff === 0;
}

async function hmacSha256(message, secret) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WEBHOOK_CRYPTO_UNAVAILABLE: Web Crypto API is required for HMAC verification');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    textEncode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, textEncode(message));
  return new Uint8Array(signature);
}

export async function hashPayload(payload) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('WEBHOOK_CRYPTO_UNAVAILABLE: Web Crypto API is required for payload hashing');
  }

  const digest = await crypto.subtle.digest('SHA-256', textEncode(payload));
  return bytesToHex(new Uint8Array(digest));
}

export async function verifyWebhookSignature(payload, signature, secret) {
  const resolvedSecret = getSecret(secret);
  if (!resolvedSecret) {
    return { valid: false, reason: 'missing_webhook_secret' };
  }

  const expectedBytes = await hmacSha256(payload, resolvedSecret);
  const expectedHex = bytesToHex(expectedBytes);
  const expectedBase64 = bytesToBase64(expectedBytes);
  const provided = normaliseSignature(signature);

  return {
    valid: secureEqual(provided, expectedHex) || secureEqual(provided, expectedBase64),
    algorithm: 'HMAC-SHA256',
    expectedHash: expectedHex,
    reason: provided ? null : 'missing_signature',
  };
}

export function validateTimestamp(timestamp, {
  now = Date.now(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  allowedClockSkewMs = DEFAULT_CLOCK_SKEW_MS,
} = {}) {
  if (!timestamp) {
    return { valid: false, reason: 'missing_timestamp' };
  }

  const parsed = Number(timestamp);
  const timestampMs = Number.isFinite(parsed)
    ? (parsed < 10_000_000_000 ? parsed * 1000 : parsed)
    : Date.parse(timestamp);

  if (!Number.isFinite(timestampMs)) {
    return { valid: false, reason: 'malformed_timestamp' };
  }

  const ageMs = now - timestampMs;
  if (ageMs > maxAgeMs) {
    return { valid: false, reason: 'stale_request', ageMs, timestampMs };
  }
  if (ageMs < -allowedClockSkewMs) {
    return { valid: false, reason: 'timestamp_from_future', ageMs, timestampMs };
  }

  return { valid: true, ageMs, timestampMs };
}

export function parseJsonPayload(rawPayload) {
  try {
    return { valid: true, payload: JSON.parse(rawPayload) };
  } catch (err) {
    return { valid: false, reason: 'malformed_json', error: err.message };
  }
}

export function validatePayloadSize(rawPayload, maxBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
  const sizeBytes = byteLength(rawPayload);
  return {
    valid: sizeBytes > 0 && sizeBytes <= maxBytes,
    sizeBytes,
    maxBytes,
    reason: sizeBytes === 0 ? 'empty_payload' : sizeBytes > maxBytes ? 'payload_too_large' : null,
  };
}

export function validateSignedHeaders(headers, requiredHeaders = ['x-signature', 'x-timestamp']) {
  const missing = requiredHeaders.filter(header => !getHeader(headers, header));
  return {
    valid: missing.length === 0,
    missing,
    reason: missing.length ? 'missing_required_headers' : null,
  };
}

export async function verifyDarajaWebhookRequest({
  rawPayload,
  headers = {},
  secret,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  allowedClockSkewMs = DEFAULT_CLOCK_SKEW_MS,
  maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  requirePayloadHash = true,
} = {}) {
  const size = validatePayloadSize(rawPayload, maxPayloadBytes);
  if (!size.valid) return { valid: false, ...size };

  const signedHeaders = validateSignedHeaders(headers);
  if (!signedHeaders.valid) return { valid: false, ...signedHeaders };

  const timestamp = getHeader(headers, 'x-timestamp');
  const timestampCheck = validateTimestamp(timestamp, { maxAgeMs, allowedClockSkewMs });
  if (!timestampCheck.valid) return { valid: false, ...timestampCheck };

  const parsed = parseJsonPayload(rawPayload);
  if (!parsed.valid) return { valid: false, ...parsed };

  const payloadHash = await hashPayload(rawPayload);
  const providedHash = getHeader(headers, 'x-payload-hash') || getHeader(headers, 'x-content-sha256');
  if (requirePayloadHash && !providedHash) {
    return { valid: false, reason: 'missing_payload_hash', payloadHash };
  }
  if (providedHash && !secureEqual(normaliseSignature(providedHash), payloadHash)) {
    return { valid: false, reason: 'payload_hash_mismatch', payloadHash };
  }

  const signature = getHeader(headers, 'x-signature') || getHeader(headers, 'x-daraja-signature');
  const signedPayload = `${timestamp}.${payloadHash}.${rawPayload}`;
  const signatureCheck = await verifyWebhookSignature(signedPayload, signature, secret);

  if (!signatureCheck.valid) {
    const legacyCheck = await verifyWebhookSignature(rawPayload, signature, secret);
    if (!legacyCheck.valid) {
      return { valid: false, reason: signatureCheck.reason || 'invalid_signature', payloadHash };
    }
  }

  return {
    valid: true,
    payload: parsed.payload,
    payloadHash,
    timestampMs: timestampCheck.timestampMs,
    ageMs: timestampCheck.ageMs,
    algorithm: 'HMAC-SHA256',
  };
}

export function getWebhookHeader(headers, name) {
  return getHeader(headers, name);
}
