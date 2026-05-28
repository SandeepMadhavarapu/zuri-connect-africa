/**
 * Zuri Connect Africa — server-side device-trust helpers (Edge runtime).
 *
 * The browser knows a short fingerprint id like `fp_<8 hex chars>` derived
 * from stable signals (canvas, WebGL, fonts, screen, UA, etc.). It is NOT a
 * secret but it IS user-correlatable, so we pepper-hash it before storing.
 *
 * Helpers:
 *   * `normalizeFingerprintId(raw)` — trims + bounds-checks the client value
 *     so a junk payload cannot poison the table.
 *   * `hashFingerprint(raw)` — SHA-256(`pepper || ':' || fingerprint`), returns
 *     lowercase hex. Same hash function used by `is_trusted_device_revoked`.
 *   * `isDeviceRevoked(supabaseAdmin, userId, fingerprintHash)` — calls the
 *     `is_trusted_device_revoked` RPC for cheap deny-list checks from other
 *     Edge Functions.
 *
 * Trust boundary:
 *   * Pepper comes from the env var `DEVICE_FINGERPRINT_PEPPER`. In dev/local
 *     a deterministic fallback is used so contributors can iterate, but the
 *     function-env validator refuses to operate in production without it.
 *   * The pepper is NEVER logged.
 */

// deno-lint-ignore-file no-explicit-any

const FINGERPRINT_FORMAT = /^fp_[a-f0-9]{6,32}$/i;
const DEV_FALLBACK_PEPPER = 'zuri:devtrust:v1:dev-fallback-only';

export function readDevicePepper(): string {
  const denoLike: any = (globalThis as any).Deno;
  const fromDeno = denoLike?.env?.get?.('DEVICE_FINGERPRINT_PEPPER');
  if (fromDeno && typeof fromDeno === 'string' && fromDeno.trim()) {
    return fromDeno.trim();
  }
  const procLike: any = (globalThis as any).process;
  const fromProc = procLike?.env?.DEVICE_FINGERPRINT_PEPPER;
  if (fromProc && typeof fromProc === 'string' && fromProc.trim()) {
    return fromProc.trim();
  }
  // requireFunctionEnv() must enforce production presence — this fallback is
  // only used in sandbox/local tests so a missing env var doesn't break the
  // whole test run.
  return DEV_FALLBACK_PEPPER;
}

export function normalizeFingerprintId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!FINGERPRINT_FORMAT.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

function toHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}

export async function hashFingerprint(fingerprintId: string, pepper?: string): Promise<string> {
  const p = pepper ?? readDevicePepper();
  const enc = new TextEncoder();
  const data = enc.encode(`${p}:${fingerprintId}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return toHex(buf);
}

export function safeDeviceLabel(raw: unknown, fallback = 'Device'): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 60);
}

/**
 * Convenience: given the raw fingerprint id sent by the client, normalize +
 * hash + consult the deny-list. Returns `false` (NOT revoked) when the client
 * did not send a fingerprint id — backward compatible with older callers. We
 * intentionally fail closed (`true`) when the RPC errors so a revoked device
 * cannot bypass by triggering a transient lookup failure.
 */
export async function isClientDeviceRevoked(
  supabaseAdmin: any,
  userId: string,
  rawFingerprintId: unknown,
): Promise<boolean> {
  const fp = normalizeFingerprintId(rawFingerprintId);
  if (!fp) return false;
  try {
    const hash = await hashFingerprint(fp);
    return await isDeviceRevoked(supabaseAdmin, userId, hash);
  } catch (e) {
    console.error('[device-trust] hash/check exception; failing closed', (e as Error).message);
    return true;
  }
}

export async function isDeviceRevoked(
  supabaseAdmin: any,
  userId: string,
  fingerprintHash: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc('is_trusted_device_revoked', {
      p_user_id: userId,
      p_fingerprint_hash: fingerprintHash,
    });
    if (error) {
      console.error('[device-trust] revoke-check rpc failed; failing closed', error.message);
      // Fail closed: if we cannot determine, assume revoked so the caller can
      // demand a fresh trust step instead of silently allowing.
      return true;
    }
    return Boolean(data);
  } catch (e) {
    console.error('[device-trust] revoke-check exception; failing closed', (e as Error).message);
    return true;
  }
}

/**
 * Snapshot returned to the browser. NEVER include `device_fingerprint_hash`.
 */
export type SafeDeviceRow = {
  id: string;
  device_label: string;
  last_seen_at: string;
  trusted: boolean;
  revoked_at: string | null;
  revoked_reason: string | null;
  webauthn_credential_id: string | null;
  created_at: string;
  is_current: boolean;
};

export function sanitizeDeviceRow(
  row: Record<string, unknown>,
  currentFingerprintHash: string | null,
): SafeDeviceRow {
  return {
    id: String(row.id ?? ''),
    device_label: typeof row.device_label === 'string' ? row.device_label : 'Device',
    last_seen_at: typeof row.last_seen_at === 'string' ? row.last_seen_at : new Date().toISOString(),
    trusted: Boolean(row.trusted),
    revoked_at: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    revoked_reason: typeof row.revoked_reason === 'string' ? row.revoked_reason : null,
    webauthn_credential_id:
      typeof row.webauthn_credential_id === 'string' ? row.webauthn_credential_id : null,
    created_at: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
    is_current:
      Boolean(currentFingerprintHash) &&
      typeof row.device_fingerprint_hash === 'string' &&
      row.device_fingerprint_hash === currentFingerprintHash,
  };
}
