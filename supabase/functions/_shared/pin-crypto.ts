export const PIN_HASH_VERSION = 'pbkdf2_sha256_pepper_v1';
export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 32;

function asBytes(buf: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(buf)) {
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  return new Uint8Array(buf);
}

function bufToHex(buf: ArrayBuffer | ArrayBufferView): string {
  return Array.from(asBytes(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function normalizePin(pin: unknown): string | null {
  const cleaned = String(pin ?? '').trim();
  if (!/^\d{6}$/.test(cleaned)) return null;
  return cleaned;
}

export function getPinPepper(): string {
  const pepper = typeof Deno !== 'undefined' && Deno.env?.get
    ? Deno.env.get('PIN_PEPPER') ?? ''
    : typeof process !== 'undefined'
      ? String(process.env.PIN_PEPPER ?? '')
      : '';
  if (!pepper || pepper.length < 16) {
    throw new Error('PIN_PEPPER_NOT_CONFIGURED');
  }
  return pepper;
}

function pinMaterial(pin: string, pepper: string): string {
  return `${pin}\x00${pepper}`;
}

async function derivePbkdf2(material: string, saltBuf: ArrayBuffer | ArrayBufferView): Promise<string> {
  const enc = new TextEncoder();
  const salt = new Uint8Array(asBytes(saltBuf));
  const keyMat = await crypto.subtle.importKey(
    'raw',
    enc.encode(material),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMat,
    256
  );
  return bufToHex(bits);
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return bufToHex(digest);
}

export async function hashPinWithPepper(pin: string, pepper: string): Promise<string> {
  const saltBuf = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hashHex = await derivePbkdf2(pinMaterial(pin, pepper), saltBuf);
  return `${bufToHex(saltBuf)}:${hashHex}`;
}

async function verifyLegacyClientHash(pin: string, storedValue: string): Promise<boolean> {
  if (!storedValue.includes(':')) {
    const legacy = await sha256Hex(`${pin}zuri_salt_v1`);
    return constantTimeEqual(legacy, storedValue);
  }
  const colonIdx = storedValue.indexOf(':');
  const saltHex = storedValue.slice(0, colonIdx);
  const hashHex = storedValue.slice(colonIdx + 1);
  const derived = await derivePbkdf2(pin, hexToBuf(saltHex));
  return constantTimeEqual(derived, hashHex);
}

export async function verifyPinWithPepper(
  pin: string,
  storedValue: string | null,
  pepper: string,
  hashVersion?: string | null
): Promise<boolean> {
  if (!storedValue || !pin) return false;

  if (hashVersion === PIN_HASH_VERSION || storedValue.startsWith('pepper:')) {
    const payload = storedValue.startsWith('pepper:') ? storedValue.slice(7) : storedValue;
    const colonIdx = payload.indexOf(':');
    if (colonIdx < 0) return false;
    const saltHex = payload.slice(0, colonIdx);
    const hashHex = payload.slice(colonIdx + 1);
    const derived = await derivePbkdf2(pinMaterial(pin, pepper), hexToBuf(saltHex));
    return constantTimeEqual(derived, hashHex);
  }

  if (hashVersion === 'pbkdf2_sha256_v1' || (storedValue.includes(':') && !storedValue.startsWith('pepper:'))) {
    return verifyLegacyClientHash(pin, storedValue);
  }

  return verifyLegacyClientHash(pin, storedValue);
}

export async function storePepperPinHash(pin: string, pepper: string): Promise<string> {
  const core = await hashPinWithPepper(pin, pepper);
  return `pepper:${core}`;
}
