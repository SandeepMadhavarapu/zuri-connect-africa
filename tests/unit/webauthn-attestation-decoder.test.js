/**
 * Tests for the WebAuthn attestation decoder used by the verify-biometric
 * Edge Function.
 *
 * Root cause this test guards against: the CBOR reader previously did not
 * support major type 1 (negative integer), so platform authenticators that
 * returned a `packed` (or `apple-anonymous`) attestation with `alg: -7`
 * failed parsing and the register endpoint rejected the credential with
 * `attestation_object_invalid`.
 *
 * The decoder also accepts base64 OR base64url so the frontend (which now
 * serializes WebAuthn ArrayBuffers as base64url) and any legacy stored
 * credentials both decode successfully.
 */

import { describe, expect, it } from 'vitest';
import { base64ToUint8Array } from '../../supabase/functions/_shared/webauthn-config.ts';
import {
  readCborItem,
  getAuthDataFromAttestationObject,
} from '../../supabase/functions/_shared/webauthn-attestation.ts';

// ── Minimal CBOR encoder helpers (test-only) ────────────────────────────────
// Only enough functionality to build attestation-object-shaped payloads.

function encodeHead(major, n) {
  if (n < 24) return Uint8Array.of((major << 5) | n);
  if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
  if (n < 0x10000) return Uint8Array.of((major << 5) | 25, (n >> 8) & 0xff, n & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  );
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function cborUint(n) {
  return encodeHead(0, n);
}

function cborNegInt(n) {
  // CBOR encodes negative integers as -1 - encoded. e.g. -7 -> encoded = 6.
  return encodeHead(1, -1 - n);
}

function cborText(s) {
  const bytes = new TextEncoder().encode(s);
  return concat([encodeHead(3, bytes.length), bytes]);
}

function cborBytes(bytes) {
  return concat([encodeHead(2, bytes.length), bytes]);
}

function cborMap(entries) {
  const head = encodeHead(5, entries.length);
  return concat([head, ...entries.flatMap(([k, v]) => [k, v])]);
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function bytesToBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePackedAttestation({ authData, sig }) {
  // { fmt: "packed", attStmt: { alg: -7, sig: <bytes> }, authData: <bytes> }
  return cborMap([
    [cborText('fmt'),     cborText('packed')],
    [cborText('attStmt'), cborMap([
      [cborText('alg'), cborNegInt(-7)],
      [cborText('sig'), cborBytes(sig)],
    ])],
    [cborText('authData'), cborBytes(authData)],
  ]);
}

function makeNoneAttestation({ authData }) {
  return cborMap([
    [cborText('fmt'),      cborText('none')],
    [cborText('attStmt'),  cborMap([])],
    [cborText('authData'), cborBytes(authData)],
  ]);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('webauthn-config: base64ToUint8Array tolerates both base64 and base64url', () => {
  it('decodes standard base64 with padding', () => {
    expect(Array.from(base64ToUint8Array('CQgHBg=='))).toEqual([9, 8, 7, 6]);
  });

  it('decodes base64url with no padding (URL-safe alphabet)', () => {
    expect(Array.from(base64ToUint8Array('CQgHBg'))).toEqual([9, 8, 7, 6]);
  });

  it('decodes base64url containing URL-safe characters (-, _) to the same bytes as base64 (+/)', () => {
    // bytes -> base64 contains '+' and '/'; base64url replaces with '-' and '_'.
    // 0xfb 0xff 0xbf -> base64 "+/+/" -> base64url "-_-_"
    const std = base64ToUint8Array('+/+/');
    const url = base64ToUint8Array('-_-_');
    expect(Array.from(std)).toEqual(Array.from(url));
  });

  it('tolerates missing padding on standard base64', () => {
    expect(Array.from(base64ToUint8Array('CQgHBg='))).toEqual([9, 8, 7, 6]);
    expect(Array.from(base64ToUint8Array('CQgHBg'))).toEqual([9, 8, 7, 6]);
  });
});

describe('webauthn-attestation: CBOR reader supports major type 1 (negative integer)', () => {
  it('decodes alg: -7 (COSE ES256) from a packed attestation', () => {
    // Build the packed attStmt: { alg: -7, sig: <bytes> }
    const attStmt = cborMap([
      [cborText('alg'), cborNegInt(-7)],
      [cborText('sig'), cborBytes(Uint8Array.of(0xab, 0xcd))],
    ]);
    const result = readCborItem(attStmt);
    expect(result.value).toEqual({ alg: -7, sig: Uint8Array.of(0xab, 0xcd) });
  });

  it('decodes mixed positive and negative integers and arrays', () => {
    const arr = concat([
      encodeHead(4, 3),    // array length 3
      cborUint(5),
      cborNegInt(-1),
      cborNegInt(-257),    // RS256
    ]);
    const result = readCborItem(arr);
    expect(result.value).toEqual([5, -1, -257]);
  });
});

describe('webauthn-attestation: getAuthDataFromAttestationObject', () => {
  const authData = new Uint8Array(40);
  for (let i = 0; i < 40; i++) authData[i] = i;

  it('extracts authData from a packed attestation with alg: -7 (regression: previously crashed)', () => {
    const attObjBytes = makePackedAttestation({ authData, sig: Uint8Array.of(1, 2, 3) });
    const b64 = bytesToBase64(attObjBytes);
    const got = getAuthDataFromAttestationObject(b64);
    expect(got).not.toBeNull();
    expect(Array.from(got)).toEqual(Array.from(authData));
  });

  it('extracts authData when the frontend sends the payload as base64url (no padding)', () => {
    const attObjBytes = makePackedAttestation({ authData, sig: Uint8Array.of(9, 9, 9) });
    const b64url = bytesToBase64Url(attObjBytes);
    expect(b64url).not.toContain('=');
    const got = getAuthDataFromAttestationObject(b64url);
    expect(got).not.toBeNull();
    expect(Array.from(got)).toEqual(Array.from(authData));
  });

  it('also handles "none" attestation with empty attStmt', () => {
    const attObjBytes = makeNoneAttestation({ authData });
    const b64 = bytesToBase64(attObjBytes);
    const got = getAuthDataFromAttestationObject(b64);
    expect(got).not.toBeNull();
    expect(Array.from(got)).toEqual(Array.from(authData));
  });

  it('throws on malformed bytes — caller maps to attestation_object_invalid (fails closed)', () => {
    const garbage = bytesToBase64(Uint8Array.of(0xff, 0xff, 0xff));
    expect(() => getAuthDataFromAttestationObject(garbage)).toThrow();
  });

  it('returns null when authData key is missing — caller maps to attestation_auth_data_missing', () => {
    const attObjBytes = cborMap([
      [cborText('fmt'),     cborText('packed')],
      [cborText('attStmt'), cborMap([])],
    ]);
    const got = getAuthDataFromAttestationObject(bytesToBase64(attObjBytes));
    expect(got).toBeNull();
  });
});
