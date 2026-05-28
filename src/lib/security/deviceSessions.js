/**
 * Zuri Connect Africa — server-backed device sessions client.
 *
 * The browser MUST NOT trust localStorage for "is this device revoked?"
 * decisions. Every list/trust/revoke goes through the `security-devices`
 * Edge Function (service role + audit log + RLS-protected table).
 *
 * Trust boundary:
 *   * The fingerprint id (`fp_<hex>`) is collected locally and sent to the
 *     Edge Function over HTTPS — the Edge Function pepper-hashes it before
 *     storing.
 *   * The browser NEVER sees the stored hash, only opaque device ids + labels.
 *   * If Supabase is unconfigured / offline we fail closed with a clear error
 *     so the UI can show honest copy instead of fake success.
 */

import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';
import { getCurrentDevice } from '@/lib/deviceTrust';

const FUNCTION_NAME = 'security-devices';

/** Exposed for tests so the audit can assert the function name is unchanged. */
export const SECURITY_DEVICES_FUNCTION_NAME = FUNCTION_NAME;

function currentFingerprintId() {
  try {
    const dev = getCurrentDevice();
    return dev?.fingerprintId || null;
  } catch {
    return null;
  }
}

async function invokeAction(action, body = {}) {
  const client = getSupabaseBrowserClient();
  if (!client?.functions?.invoke) {
    return { ok: false, error: 'supabase_unavailable' };
  }
  try {
    const { data, error } = await client.functions.invoke(FUNCTION_NAME, {
      body: { action, ...body },
    });
    if (error) {
      return { ok: false, error: error.message || 'invoke_failed', status: error.status };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'invalid_response' };
    }
    return data;
  } catch (e) {
    return { ok: false, error: e?.message || 'invoke_failed' };
  }
}

/**
 * Fetch the caller's trusted devices. The fingerprint id is sent so the
 * server can flag the calling device with `is_current: true`.
 */
export async function listDevices() {
  return invokeAction('list_devices', {
    device_fingerprint_id: currentFingerprintId() || undefined,
  });
}

/**
 * Mark the current device trusted on the server. Idempotent — repeated calls
 * refresh `last_seen_at` instead of creating duplicate rows.
 */
export async function trustCurrentDeviceServer({ label } = {}) {
  const fp = currentFingerprintId();
  if (!fp) return { ok: false, error: 'no_fingerprint' };
  return invokeAction('trust_device', {
    device_fingerprint_id: fp,
    device_label: label || 'This Device',
  });
}

/**
 * Revoke a single device the caller owns. Returns `{ ok: true, revoked: true }`
 * on success. Cross-user requests are rejected with `device_not_found` so
 * existence is not leaked.
 */
export async function revokeDeviceServer({ deviceId }) {
  if (!deviceId || typeof deviceId !== 'string') {
    return { ok: false, error: 'invalid_device_id' };
  }
  return invokeAction('revoke_device', { device_id: deviceId });
}

/**
 * Revoke every trusted device except the calling one. Useful for "sign out
 * all other devices". Active sessions remain bound to their refresh tokens
 * (a Supabase Auth limitation) but they can no longer pass step-up checks
 * because the deny-list is consulted by every sensitive Edge Function.
 */
export async function revokeAllOtherDevicesServer() {
  const fp = currentFingerprintId();
  if (!fp) return { ok: false, error: 'no_fingerprint' };
  return invokeAction('revoke_all_other_devices', { device_fingerprint_id: fp });
}
