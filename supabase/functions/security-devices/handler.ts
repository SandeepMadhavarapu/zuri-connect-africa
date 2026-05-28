/**
 * Zuri Connect Africa — security-devices dispatcher.
 *
 * Pure logic only. The Deno-specific wrapper lives in `index.ts`.
 *
 * Actions (all require an authenticated user JWT):
 *   * list_devices                — returns the caller's own trusted devices.
 *   * trust_device                — registers / re-trusts the calling device.
 *   * revoke_device               — marks a single device revoked (deny-list).
 *   * revoke_all_other_devices    — marks every device except the calling
 *                                   fingerprint revoked.
 *
 * Cross-user access is NEVER permitted. Every mutation writes a
 * `security_events` audit row. The browser never receives the stored
 * `device_fingerprint_hash` — only safe labels + ids.
 *
 * NB: Supabase Edge Functions cannot selectively invalidate another device's
 * refresh token (the supabase-js admin client only exposes signOut by JWT).
 * We therefore enforce revocation server-side via the
 * `is_trusted_device_revoked` RPC, consulted by every sensitive Edge Function
 * (initiate-payment, complete-step-up, set-pin, verify-biometric).
 */

// deno-lint-ignore-file no-explicit-any

import {
  hashFingerprint,
  isDeviceRevoked as deviceIsRevoked,
  normalizeFingerprintId,
  safeDeviceLabel,
  sanitizeDeviceRow,
  type SafeDeviceRow,
} from '../_shared/device-trust.ts';

type Json = Record<string, unknown>;

type Auth = {
  userId: string;
  user: {
    id: string;
    email?: string;
    phone?: string;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
  };
};

const VALID_ACTIONS = new Set([
  'list_devices',
  'trust_device',
  'revoke_device',
  'revoke_all_other_devices',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SecurityDevicesDeps = {
  supabaseAdmin: any;
  /** Override `requireAuth` in tests so we don't have to validate real JWTs. */
  requireAuth?: (req: Request) => Promise<Auth | { ok: false; status: number; body: Json }>;
};

export type DispatcherResult = { status: number; body: Json };

async function defaultRequireAuth(
  req: Request,
  supabaseAdmin: any,
): Promise<Auth | { ok: false; status: number; body: Json }> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { ok: false, status: 401, body: { ok: false, error: 'missing_authorization' } };
  const { data: userRes, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !userRes?.user) {
    return { ok: false, status: 401, body: { ok: false, error: 'invalid_token' } };
  }
  const u = userRes.user;
  return {
    userId: u.id,
    user: {
      id: u.id,
      email: u.email,
      phone: u.phone ?? undefined,
      app_metadata: (u.app_metadata ?? {}) as Record<string, unknown>,
      user_metadata: (u.user_metadata ?? {}) as Record<string, unknown>,
    },
  };
}

function safeError(code: string, status = 400, extra: Json = {}): DispatcherResult {
  return { status, body: { ok: false, error: code, ...extra } };
}

function isAuth(v: any): v is Auth {
  return v && typeof v === 'object' && typeof v.userId === 'string';
}

async function writeSecurityEvent(
  supabaseAdmin: any,
  payload: {
    userId: string;
    event_type: string;
    action: string;
    outcome?: 'success' | 'failure' | 'denied' | 'pending';
    severity?: 'info' | 'warn' | 'error' | 'critical';
    payload?: Json;
  },
) {
  const { error } = await supabaseAdmin.from('security_events').insert({
    user_id: payload.userId,
    event_type: payload.event_type,
    action: payload.action,
    outcome: payload.outcome ?? 'success',
    severity: payload.severity ?? 'info',
    payload: payload.payload ?? {},
  });
  if (error) console.error('[security-devices] security_events insert failed', error.message);
}

async function listDevices(
  supabaseAdmin: any,
  userId: string,
  currentFingerprintHash: string | null,
): Promise<SafeDeviceRow[]> {
  // Use the user's own filter even though service role bypasses RLS — defense
  // in depth and keeps the query identical to what an authenticated reader
  // would see.
  const { data, error } = await supabaseAdmin
    .from('trusted_devices')
    .select(
      'id, device_label, last_seen_at, trusted, revoked_at, revoked_reason, webauthn_credential_id, created_at, device_fingerprint_hash',
    )
    .eq('user_id', userId)
    .order('last_seen_at', { ascending: false });

  if (error) {
    console.error('[security-devices] list failed', error.message);
    return [];
  }

  const rows = Array.isArray(data) ? data : [];
  return rows.map((row) => sanitizeDeviceRow(row as Record<string, unknown>, currentFingerprintHash));
}

async function handleList(
  supabaseAdmin: any,
  auth: Auth,
  body: Json,
): Promise<DispatcherResult> {
  let currentFingerprintHash: string | null = null;
  const fp = normalizeFingerprintId(body.device_fingerprint_id);
  if (fp) {
    try {
      currentFingerprintHash = await hashFingerprint(fp);
    } catch {
      currentFingerprintHash = null;
    }
  }

  const devices = await listDevices(supabaseAdmin, auth.userId, currentFingerprintHash);
  return {
    status: 200,
    body: { ok: true, devices, current_device_recognised: Boolean(currentFingerprintHash) },
  };
}

async function handleTrustDevice(
  supabaseAdmin: any,
  auth: Auth,
  body: Json,
): Promise<DispatcherResult> {
  const fp = normalizeFingerprintId(body.device_fingerprint_id);
  if (!fp) return safeError('invalid_device_fingerprint', 400);

  const label = safeDeviceLabel(body.device_label, 'This Device');
  const hash = await hashFingerprint(fp);

  // Upsert into the active set. The partial unique index on
  // (user_id, device_fingerprint_hash) WHERE revoked_at IS NULL guarantees
  // single-active-row semantics; we just need to either insert or refresh.
  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from('trusted_devices')
    .select('id, revoked_at')
    .eq('user_id', auth.userId)
    .eq('device_fingerprint_hash', hash)
    .is('revoked_at', null)
    .maybeSingle();

  if (lookupErr) {
    console.error('[security-devices] lookup failed', lookupErr.message);
    return safeError('trust_failed', 500);
  }

  let deviceId: string;
  const now = new Date().toISOString();
  if (existing?.id) {
    const { error: updateErr } = await supabaseAdmin
      .from('trusted_devices')
      .update({ device_label: label, last_seen_at: now, trusted: true })
      .eq('id', existing.id);
    if (updateErr) {
      console.error('[security-devices] update failed', updateErr.message);
      return safeError('trust_failed', 500);
    }
    deviceId = String(existing.id);
  } else {
    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('trusted_devices')
      .insert({
        user_id: auth.userId,
        device_label: label,
        device_fingerprint_hash: hash,
        last_seen_at: now,
        trusted: true,
      })
      .select('id')
      .maybeSingle();
    if (insertErr || !inserted?.id) {
      console.error('[security-devices] insert failed', insertErr?.message);
      return safeError('trust_failed', 500);
    }
    deviceId = String(inserted.id);
  }

  await writeSecurityEvent(supabaseAdmin, {
    userId: auth.userId,
    event_type: 'device_trust.granted',
    action: 'trust_device',
    payload: { device_id: deviceId },
  });

  return {
    status: 200,
    body: { ok: true, device_id: deviceId, device_label: label, trusted: true },
  };
}

async function handleRevokeDevice(
  supabaseAdmin: any,
  auth: Auth,
  body: Json,
): Promise<DispatcherResult> {
  const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
  if (!deviceId || !UUID_RE.test(deviceId)) return safeError('invalid_device_id', 400);

  // CRITICAL: only allow the caller to revoke their OWN devices. We always
  // pin to `user_id = auth.userId` in the WHERE clause. We re-select after
  // update so we can confirm something actually happened (cross-user attempts
  // simply match no row).
  const now = new Date().toISOString();

  // First check the row exists and belongs to the caller. Without this an
  // attacker could probe a UUID and a no-op update would return 200 with
  // affected_rows=0 — better to return a clean 404.
  const { data: target, error: targetErr } = await supabaseAdmin
    .from('trusted_devices')
    .select('id, user_id, revoked_at, device_label')
    .eq('id', deviceId)
    .maybeSingle();

  if (targetErr) {
    console.error('[security-devices] revoke lookup failed', targetErr.message);
    return safeError('revoke_failed', 500);
  }

  if (!target || target.user_id !== auth.userId) {
    await writeSecurityEvent(supabaseAdmin, {
      userId: auth.userId,
      event_type: 'device_trust.revoke_denied',
      action: 'revoke_device',
      outcome: 'denied',
      severity: 'warn',
      payload: { reason: 'not_owner_or_not_found' },
    });
    return safeError('device_not_found', 404);
  }

  if (target.revoked_at) {
    return { status: 200, body: { ok: true, device_id: deviceId, already_revoked: true } };
  }

  const { error: updErr } = await supabaseAdmin
    .from('trusted_devices')
    .update({ revoked_at: now, revoked_reason: 'user_revoked', trusted: false })
    .eq('id', deviceId)
    .eq('user_id', auth.userId);

  if (updErr) {
    console.error('[security-devices] revoke update failed', updErr.message);
    return safeError('revoke_failed', 500);
  }

  await writeSecurityEvent(supabaseAdmin, {
    userId: auth.userId,
    event_type: 'device_trust.revoked',
    action: 'revoke_device',
    payload: { device_id: deviceId },
  });

  return { status: 200, body: { ok: true, device_id: deviceId, revoked: true } };
}

async function handleRevokeAllOthers(
  supabaseAdmin: any,
  auth: Auth,
  body: Json,
): Promise<DispatcherResult> {
  const fp = normalizeFingerprintId(body.device_fingerprint_id);
  if (!fp) return safeError('invalid_device_fingerprint', 400);

  const currentHash = await hashFingerprint(fp);
  const now = new Date().toISOString();

  // Update every active row EXCEPT the calling device.
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('trusted_devices')
    .update({ revoked_at: now, revoked_reason: 'all_other_devices', trusted: false })
    .eq('user_id', auth.userId)
    .is('revoked_at', null)
    .neq('device_fingerprint_hash', currentHash)
    .select('id');

  if (updErr) {
    console.error('[security-devices] revoke-all-others failed', updErr.message);
    return safeError('revoke_failed', 500);
  }

  const count = Array.isArray(updated) ? updated.length : 0;

  await writeSecurityEvent(supabaseAdmin, {
    userId: auth.userId,
    event_type: 'device_trust.revoked_all_others',
    action: 'revoke_all_other_devices',
    severity: count > 0 ? 'warn' : 'info',
    payload: { revoked_count: count },
  });

  return {
    status: 200,
    body: { ok: true, revoked_count: count },
  };
}

export async function handleSecurityDevices(
  req: Request,
  deps: SecurityDevicesDeps,
): Promise<DispatcherResult> {
  const requireAuth = deps.requireAuth ?? ((r: Request) => defaultRequireAuth(r, deps.supabaseAdmin));

  let parsed: Json;
  try {
    parsed = (await req.json()) as Json;
  } catch {
    return safeError('invalid_json', 400);
  }

  const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
  if (!VALID_ACTIONS.has(action)) return safeError('invalid_action', 400);

  const auth = await requireAuth(req);
  if (!isAuth(auth)) {
    // requireAuth returns a { ok:false, status, body } shape on failure.
    const failure = auth as { ok: false; status: number; body: Json };
    return { status: failure.status ?? 401, body: failure.body ?? { ok: false, error: 'unauthorized' } };
  }

  try {
    switch (action) {
      case 'list_devices':
        return await handleList(deps.supabaseAdmin, auth, parsed);
      case 'trust_device':
        return await handleTrustDevice(deps.supabaseAdmin, auth, parsed);
      case 'revoke_device':
        return await handleRevokeDevice(deps.supabaseAdmin, auth, parsed);
      case 'revoke_all_other_devices':
        return await handleRevokeAllOthers(deps.supabaseAdmin, auth, parsed);
      default:
        return safeError('invalid_action', 400);
    }
  } catch (e) {
    console.error('[security-devices] dispatcher error', (e as Error).message);
    return safeError('internal_error', 500);
  }
}

// Re-export the deny-list checker so other Edge Functions can do
//   import { isDeviceRevokedForUser } from '../security-devices/handler.ts';
// without taking a hard dependency on the shared module.
export async function isDeviceRevokedForUser(
  supabaseAdmin: any,
  userId: string,
  fingerprintId: string,
): Promise<boolean> {
  const fp = normalizeFingerprintId(fingerprintId);
  if (!fp) return false;
  const hash = await hashFingerprint(fp);
  return deviceIsRevoked(supabaseAdmin, userId, hash);
}
