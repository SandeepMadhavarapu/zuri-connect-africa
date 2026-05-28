/**
 * Minimal CBOR decoder for WebAuthn attestation objects.
 *
 * Attestation objects (RFC 8152 / WebAuthn §6.5) are CBOR-encoded maps of the form:
 *   { fmt: text, attStmt: map, authData: bytes }
 *
 * Platform authenticators (Windows Hello, Touch ID, Android) typically return a
 * `packed`, `apple-anonymous`, or `tpm` attestation whose attStmt contains
 * `alg: -7` (COSE alg id for ES256). `alg: -7` is a CBOR **negative integer**
 * (major type 1), so any CBOR reader used for these payloads MUST support
 * major type 1 — otherwise parsing throws and the register endpoint rejects
 * the credential with `attestation_object_invalid`.
 *
 * This module supports the CBOR subset required by WebAuthn attestation:
 *   - major 0: unsigned integer
 *   - major 1: negative integer
 *   - major 2: byte string
 *   - major 3: text string
 *   - major 4: array
 *   - major 5: map (string keys produced via String(key))
 *   - major 6: tagged value (tag stripped, inner item returned)
 *   - major 7: simple values false/true/null
 *
 * It deliberately does NOT support indefinite-length items, floats, or 8-byte
 * lengths because those are not used in real WebAuthn attestation objects.
 *
 * The decoder is intentionally strict: anything unexpected throws, and the
 * register handler maps the thrown error to a generic `attestation_object_invalid`
 * response so no raw bytes leak to the client.
 */

import { base64ToUint8Array } from './webauthn-config.ts';

export interface CborReadResult<T = unknown> {
  value: T;
  offset: number;
}

function readCborLength(bytes: Uint8Array, offset: number, additional: number): { length: number; offset: number } {
  if (additional < 24) return { length: additional, offset };
  if (additional === 24) {
    if (offset + 1 > bytes.length) throw new Error('cbor_truncated');
    return { length: bytes[offset], offset: offset + 1 };
  }
  if (additional === 25) {
    if (offset + 2 > bytes.length) throw new Error('cbor_truncated');
    return { length: (bytes[offset] << 8) | bytes[offset + 1], offset: offset + 2 };
  }
  if (additional === 26) {
    if (offset + 4 > bytes.length) throw new Error('cbor_truncated');
    return {
      length:
        ((bytes[offset] << 24) >>> 0) +
        (bytes[offset + 1] << 16) +
        (bytes[offset + 2] << 8) +
        bytes[offset + 3],
      offset: offset + 4,
    };
  }
  throw new Error('unsupported_cbor_length');
}

export function readCborItem(bytes: Uint8Array, offset = 0): CborReadResult {
  if (offset >= bytes.length) throw new Error('cbor_truncated');
  const head = bytes[offset++];
  const major = head >> 5;
  const additional = head & 0x1f;
  const len = readCborLength(bytes, offset, additional);
  const length = len.length;
  offset = len.offset;

  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2) {
    if (offset + length > bytes.length) throw new Error('cbor_truncated');
    return { value: bytes.slice(offset, offset + length), offset: offset + length };
  }
  if (major === 3) {
    if (offset + length > bytes.length) throw new Error('cbor_truncated');
    return {
      value: new TextDecoder().decode(bytes.slice(offset, offset + length)),
      offset: offset + length,
    };
  }
  if (major === 4) {
    const arr: unknown[] = [];
    for (let i = 0; i < length; i++) {
      const item = readCborItem(bytes, offset);
      arr.push(item.value);
      offset = item.offset;
    }
    return { value: arr, offset };
  }
  if (major === 5) {
    const map: Record<string, unknown> = {};
    for (let i = 0; i < length; i++) {
      const key = readCborItem(bytes, offset);
      offset = key.offset;
      const value = readCborItem(bytes, offset);
      offset = value.offset;
      map[String(key.value)] = value.value;
    }
    return { value: map, offset };
  }
  if (major === 6) return readCborItem(bytes, offset);
  if (major === 7) {
    if (length === 20) return { value: false, offset };
    if (length === 21) return { value: true, offset };
    if (length === 22 || length === 23) return { value: null, offset };
    throw new Error('unsupported_cbor_simple');
  }
  throw new Error('unsupported_cbor_item');
}

/**
 * Extract the raw `authData` byte string from a base64(url)-encoded WebAuthn
 * attestation object. Returns null when the field is missing or not bytes.
 * Throws on malformed CBOR — callers MUST catch and map to a safe error code.
 */
export function getAuthDataFromAttestationObject(attestationObjectB64: string): Uint8Array | null {
  const parsed = readCborItem(base64ToUint8Array(attestationObjectB64));
  const obj = parsed.value as Record<string, unknown> | null;
  const authData = obj?.authData;
  return authData instanceof Uint8Array ? authData : null;
}
