/**
 * Zuri Connect Africa — security-devices Edge Function tests.
 *
 * These tests exercise the pure dispatcher (`handleSecurityDevices`) with an
 * in-memory Supabase-like mock so we can assert:
 *
 *   * Unauthenticated callers are rejected.
 *   * Authenticated callers can list / trust / revoke their OWN devices.
 *   * Cross-user revocation is denied (status 404, audit-logged as `denied`).
 *   * Revoked rows set `revoked_at` + `revoked_reason='user_revoked'` and are
 *     no longer surfaced as active.
 *   * `security_events` rows are written for every mutation.
 *   * No `device_fingerprint_hash` ever leaks into a response.
 *   * The shared hash helper is deterministic + pepper-bound.
 *   * Migration ships an RLS-protected table + the deny-list RPC.
 *
 * Pure logic only — no Deno, no network, no Supabase project required.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  handleSecurityDevices,
  isDeviceRevokedForUser,
} from '../../supabase/functions/security-devices/handler.ts';
import {
  hashFingerprint,
  normalizeFingerprintId,
  safeDeviceLabel,
  sanitizeDeviceRow,
  isClientDeviceRevoked,
} from '../../supabase/functions/_shared/device-trust.ts';

// ── Test fixtures ────────────────────────────────────────────────────────────

function makeRequest(body, { headers = { authorization: 'Bearer fake.jwt.token' } } = {}) {
  return new Request('https://example.com/functions/v1/security-devices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * Mutable in-memory `trusted_devices` + `security_events` store with a
 * Supabase-builder-shaped surface. Mirrors only the bits the handler needs.
 */
function makeStore({ user = { id: 'user-1', email: 'u@example.com' }, authError = null } = {}) {
  const tables = {
    trusted_devices: [],
    security_events: [],
  };
  const rpcCalls = [];

  function builderFor(table) {
    let filters = [];
    let _columns = '*';
    let _orderBy = null;

    const applyFilters = (rows) =>
      rows.filter((r) =>
        filters.every(([op, col, val]) => {
          const v = r[col];
          if (op === 'eq') return v === val;
          if (op === 'neq') return v !== val;
          if (op === 'is' && val === null) return v == null;
          return true;
        }),
      );

    const chain = {
      select(cols) {
        _columns = cols || '*';
        return chain;
      },
      eq(col, val) { filters.push(['eq', col, val]); return chain; },
      neq(col, val) { filters.push(['neq', col, val]); return chain; },
      is(col, val) { filters.push(['is', col, val]); return chain; },
      order(col, opts) { _orderBy = { col, asc: opts?.ascending !== false }; return chain; },
      limit() { return chain; },
      async maybeSingle() {
        const rows = applyFilters(tables[table] || []);
        return { data: rows[0] || null, error: null };
      },
      insert(payload) {
        const row = Array.isArray(payload) ? payload[0] : payload;
        const inserted = {
          id: `row-${(tables[table].length + 1).toString().padStart(4, '0')}`,
          created_at: new Date().toISOString(),
          last_seen_at: row.last_seen_at || new Date().toISOString(),
          revoked_at: null,
          revoked_reason: null,
          trusted: true,
          ...row,
        };
        tables[table].push(inserted);
        const result = {
          select(_c) {
            return {
              async maybeSingle() {
                return { data: inserted, error: null };
              },
              async single() {
                return { data: inserted, error: null };
              },
            };
          },
          then(onResolve) {
            return Promise.resolve({ data: null, error: null }).then(onResolve);
          },
        };
        return result;
      },
      update(payload) {
        // Build a thenable chain that accepts an arbitrary sequence of
        // eq/is/neq filters and resolves to the matched-and-mutated rows.
        // Matches supabase-js v2's `.from(...).update(...).eq().is()...` shape.
        const applyAndResolve = () => {
          const rows = applyFilters(tables[table] || []);
          rows.forEach((r) => Object.assign(r, payload));
          return { data: rows, error: null };
        };
        const updater = {
          eq(col, val) { filters.push(['eq', col, val]); return updater; },
          is(col, val) { filters.push(['is', col, val]); return updater; },
          neq(col, val) { filters.push(['neq', col, val]); return updater; },
          select() {
            // Terminal — return matched+mutated rows.
            return Promise.resolve(applyAndResolve());
          },
          then(onResolve, onReject) {
            return Promise.resolve(applyAndResolve()).then(onResolve, onReject);
          },
        };
        return updater;
      },
      then(onResolve, onReject) {
        let rows = applyFilters(tables[table] || []);
        if (_orderBy) {
          rows = [...rows].sort((a, b) => {
            const av = a[_orderBy.col] ?? '';
            const bv = b[_orderBy.col] ?? '';
            return _orderBy.asc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
          });
        }
        return Promise.resolve({ data: rows, error: null }).then(onResolve, onReject);
      },
    };
    return chain;
  }

  return {
    _tables: tables,
    _rpcCalls: rpcCalls,
    auth: {
      getUser: async () => ({ data: { user: authError ? null : user }, error: authError }),
    },
    from(table) { return builderFor(table); },
    rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === 'is_trusted_device_revoked') {
        const revoked = (tables.trusted_devices || []).some(
          (r) => r.user_id === args.p_user_id && r.device_fingerprint_hash === args.p_fingerprint_hash && r.revoked_at,
        );
        return Promise.resolve({ data: revoked, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

// Replace the dispatcher's default auth path so we can drive identity from a
// test fixture without minting JWTs.
function authFor(userId) {
  return async () => ({ userId, user: { id: userId, app_metadata: {}, user_metadata: {} } });
}

// ── shared helpers ──────────────────────────────────────────────────────────

describe('device-trust shared helpers', () => {
  it('normalizes fingerprint ids and rejects junk', () => {
    expect(normalizeFingerprintId('fp_abcd1234')).toBe('fp_abcd1234');
    expect(normalizeFingerprintId('  FP_ABCD1234  ')).toBe('fp_abcd1234');
    expect(normalizeFingerprintId('not-a-fp')).toBeNull();
    expect(normalizeFingerprintId(123)).toBeNull();
    expect(normalizeFingerprintId(null)).toBeNull();
    // Reject embedded XSS-y payloads.
    expect(normalizeFingerprintId('fp_<script>alert(1)</script>')).toBeNull();
  });

  it('hashes are deterministic, hex, 64 chars, and pepper-bound', async () => {
    const a = await hashFingerprint('fp_abcd1234', 'pepper-a');
    const b = await hashFingerprint('fp_abcd1234', 'pepper-a');
    const c = await hashFingerprint('fp_abcd1234', 'pepper-b');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('safeDeviceLabel strips control characters and caps length', () => {
    expect(safeDeviceLabel('  Pixel 8  ')).toBe('Pixel 8');
    expect(safeDeviceLabel('Hello\u0007World')).toBe('HelloWorld');
    expect(safeDeviceLabel('').length).toBeGreaterThan(0);
    const long = 'a'.repeat(120);
    expect(safeDeviceLabel(long).length).toBe(60);
  });

  it('sanitizeDeviceRow never leaks the fingerprint hash', () => {
    const sanitized = sanitizeDeviceRow(
      {
        id: 'dev-1',
        device_label: 'Pixel',
        last_seen_at: '2026-05-21T00:00:00Z',
        trusted: true,
        revoked_at: null,
        revoked_reason: null,
        webauthn_credential_id: null,
        created_at: '2026-05-20T00:00:00Z',
        device_fingerprint_hash: 'a'.repeat(64),
      },
      'a'.repeat(64),
    );
    expect(sanitized).not.toHaveProperty('device_fingerprint_hash');
    expect(sanitized.is_current).toBe(true);
  });

  it('isClientDeviceRevoked: fail-closed on RPC error, fail-open on missing fp', async () => {
    const store = {
      rpc: async () => ({ data: null, error: { message: 'boom' } }),
    };
    // Missing fingerprint id ⇒ NOT revoked (backwards compatible).
    expect(await isClientDeviceRevoked(store, 'u', undefined)).toBe(false);
    // RPC error ⇒ revoked=true (fail closed).
    expect(await isClientDeviceRevoked(store, 'u', 'fp_abcd1234')).toBe(true);
  });
});

// ── handler: action validation ───────────────────────────────────────────────

describe('handleSecurityDevices · action validation', () => {
  it('rejects invalid JSON with 400', async () => {
    const supabase = makeStore();
    const req = new Request('https://example.com/security-devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const res = await handleSecurityDevices(req, { supabaseAdmin: supabase, requireAuth: authFor('u1') });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_json');
  });

  it('rejects unknown actions with 400', async () => {
    const supabase = makeStore();
    const res = await handleSecurityDevices(makeRequest({ action: 'delete_user' }), {
      supabaseAdmin: supabase,
      requireAuth: authFor('u1'),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_action');
  });

  it('rejects missing Authorization with 401 (default auth path)', async () => {
    const supabase = makeStore({ authError: { message: 'invalid' } });
    const req = new Request('https://example.com/security-devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list_devices' }),
    });
    const res = await handleSecurityDevices(req, { supabaseAdmin: supabase });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/missing_authorization|invalid_token/);
  });
});

// ── handler: list + trust ────────────────────────────────────────────────────

describe('handleSecurityDevices · list_devices', () => {
  it('returns only the caller\'s devices and never leaks the fingerprint hash', async () => {
    const supabase = makeStore();
    // Pre-seed one row for caller and one for another user.
    supabase._tables.trusted_devices.push({
      id: 'dev-a',
      user_id: 'u1',
      device_label: 'My Phone',
      device_fingerprint_hash: 'a'.repeat(64),
      last_seen_at: '2026-05-21T00:00:00Z',
      trusted: true,
      revoked_at: null,
      created_at: '2026-05-20T00:00:00Z',
    });
    supabase._tables.trusted_devices.push({
      id: 'dev-other',
      user_id: 'u2',
      device_label: 'Attacker Phone',
      device_fingerprint_hash: 'b'.repeat(64),
      last_seen_at: '2026-05-21T00:00:00Z',
      trusted: true,
      revoked_at: null,
      created_at: '2026-05-20T00:00:00Z',
    });

    const res = await handleSecurityDevices(makeRequest({ action: 'list_devices' }), {
      supabaseAdmin: supabase,
      requireAuth: authFor('u1'),
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].id).toBe('dev-a');
    // No raw hash on the wire.
    expect(JSON.stringify(res.body)).not.toContain('a'.repeat(64));
  });
});

describe('handleSecurityDevices · trust_device', () => {
  it('inserts a new active row and writes a security_event', async () => {
    const supabase = makeStore();
    const res = await handleSecurityDevices(
      makeRequest({
        action: 'trust_device',
        device_fingerprint_id: 'fp_abcd1234',
        device_label: 'My Pixel',
      }),
      { supabaseAdmin: supabase, requireAuth: authFor('u1') },
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(supabase._tables.trusted_devices).toHaveLength(1);
    const row = supabase._tables.trusted_devices[0];
    expect(row.user_id).toBe('u1');
    expect(row.device_label).toBe('My Pixel');
    expect(row.device_fingerprint_hash).toMatch(/^[a-f0-9]{64}$/);

    const audit = supabase._tables.security_events;
    expect(audit.some((e) => e.event_type === 'device_trust.granted' && e.user_id === 'u1')).toBe(true);
  });

  it('refuses junk fingerprint ids', async () => {
    const supabase = makeStore();
    const res = await handleSecurityDevices(
      makeRequest({
        action: 'trust_device',
        device_fingerprint_id: 'not-a-fingerprint',
      }),
      { supabaseAdmin: supabase, requireAuth: authFor('u1') },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_device_fingerprint');
  });
});

// ── handler: revoke flows ────────────────────────────────────────────────────

describe('handleSecurityDevices · revoke_device', () => {
  it('marks own device revoked, writes audit event, and surfaces as revoked', async () => {
    const supabase = makeStore();
    supabase._tables.trusted_devices.push({
      id: '11111111-1111-1111-1111-111111111111',
      user_id: 'u1',
      device_label: 'Phone',
      device_fingerprint_hash: 'a'.repeat(64),
      last_seen_at: new Date().toISOString(),
      trusted: true,
      revoked_at: null,
      created_at: new Date().toISOString(),
    });

    const res = await handleSecurityDevices(
      makeRequest({
        action: 'revoke_device',
        device_id: '11111111-1111-1111-1111-111111111111',
      }),
      { supabaseAdmin: supabase, requireAuth: authFor('u1') },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revoked).toBe(true);

    const row = supabase._tables.trusted_devices.find((d) => d.id === '11111111-1111-1111-1111-111111111111');
    expect(row.revoked_at).toBeTruthy();
    expect(row.revoked_reason).toBe('user_revoked');
    expect(row.trusted).toBe(false);

    expect(
      supabase._tables.security_events.some(
        (e) => e.event_type === 'device_trust.revoked' && e.outcome === 'success' && e.user_id === 'u1',
      ),
    ).toBe(true);
  });

  it('refuses cross-user revoke with 404 and writes a denied security_event', async () => {
    const supabase = makeStore();
    supabase._tables.trusted_devices.push({
      id: '22222222-2222-2222-2222-222222222222',
      user_id: 'victim',
      device_label: 'Victim Phone',
      device_fingerprint_hash: 'c'.repeat(64),
      last_seen_at: new Date().toISOString(),
      trusted: true,
      revoked_at: null,
      created_at: new Date().toISOString(),
    });

    const res = await handleSecurityDevices(
      makeRequest({
        action: 'revoke_device',
        device_id: '22222222-2222-2222-2222-222222222222',
      }),
      { supabaseAdmin: supabase, requireAuth: authFor('attacker') },
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('device_not_found');

    // Victim's row is untouched.
    const victimRow = supabase._tables.trusted_devices.find(
      (d) => d.id === '22222222-2222-2222-2222-222222222222',
    );
    expect(victimRow.revoked_at).toBeNull();

    // Denied audit event is recorded under the ATTACKER's user id — never the
    // victim's, so a victim's audit log isn't spammed by attacker probes.
    const denial = supabase._tables.security_events.find(
      (e) => e.event_type === 'device_trust.revoke_denied' && e.outcome === 'denied',
    );
    expect(denial).toBeTruthy();
    expect(denial.user_id).toBe('attacker');
  });

  it('rejects malformed device_id with 400', async () => {
    const supabase = makeStore();
    const res = await handleSecurityDevices(
      makeRequest({ action: 'revoke_device', device_id: 'not-a-uuid' }),
      { supabaseAdmin: supabase, requireAuth: authFor('u1') },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_device_id');
  });
});

describe('handleSecurityDevices · revoke_all_other_devices', () => {
  it('revokes every active device except the calling fingerprint', async () => {
    const supabase = makeStore();
    const currentFp = 'fp_aaaa1111';
    const currentHash = await hashFingerprint(currentFp);
    const otherHash = await hashFingerprint('fp_bbbb2222');

    supabase._tables.trusted_devices.push(
      {
        id: 'cur',
        user_id: 'u1',
        device_label: 'Current',
        device_fingerprint_hash: currentHash,
        last_seen_at: new Date().toISOString(),
        trusted: true,
        revoked_at: null,
        created_at: new Date().toISOString(),
      },
      {
        id: 'other',
        user_id: 'u1',
        device_label: 'Other',
        device_fingerprint_hash: otherHash,
        last_seen_at: new Date().toISOString(),
        trusted: true,
        revoked_at: null,
        created_at: new Date().toISOString(),
      },
    );

    const res = await handleSecurityDevices(
      makeRequest({
        action: 'revoke_all_other_devices',
        device_fingerprint_id: currentFp,
      }),
      { supabaseAdmin: supabase, requireAuth: authFor('u1') },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.revoked_count).toBe(1);

    expect(supabase._tables.trusted_devices.find((d) => d.id === 'cur').revoked_at).toBeNull();
    const otherRow = supabase._tables.trusted_devices.find((d) => d.id === 'other');
    expect(otherRow.revoked_at).toBeTruthy();
    expect(otherRow.revoked_reason).toBe('all_other_devices');

    expect(
      supabase._tables.security_events.some(
        (e) => e.event_type === 'device_trust.revoked_all_others' && e.user_id === 'u1',
      ),
    ).toBe(true);
  });
});

// ── deny-list checker ────────────────────────────────────────────────────────

describe('isDeviceRevokedForUser deny-list check', () => {
  it('returns true once a device has a revoked_at row', async () => {
    const supabase = makeStore();
    const fp = 'fp_abcd1234';
    const hash = await hashFingerprint(fp);
    supabase._tables.trusted_devices.push({
      id: 'r1',
      user_id: 'u1',
      device_fingerprint_hash: hash,
      last_seen_at: new Date().toISOString(),
      trusted: false,
      revoked_at: new Date().toISOString(),
      revoked_reason: 'user_revoked',
      created_at: new Date().toISOString(),
    });

    expect(await isDeviceRevokedForUser(supabase, 'u1', fp)).toBe(true);
    expect(await isDeviceRevokedForUser(supabase, 'u1', 'fp_other999')).toBe(false);
  });
});

// ── migration & frontend source guarantees ──────────────────────────────────

describe('trusted_devices migration safety', () => {
  const migration = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260521000000_trusted_devices_server.sql'),
    'utf8',
  );

  it('creates the trusted_devices table with the required columns', () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS public\.trusted_devices/);
    expect(migration).toMatch(/device_fingerprint_hash\s+TEXT/);
    expect(migration).toMatch(/revoked_at\s+TIMESTAMPTZ/);
    expect(migration).toMatch(/revoked_reason\s+TEXT/);
    expect(migration).toMatch(/webauthn_credential_id\s+UUID/);
  });

  it('enables and forces row level security', () => {
    expect(migration).toMatch(/ALTER TABLE public\.trusted_devices ENABLE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/ALTER TABLE public\.trusted_devices FORCE ROW LEVEL SECURITY/);
    expect(migration).toMatch(/REVOKE ALL ON TABLE public\.trusted_devices FROM PUBLIC/);
  });

  it('grants users SELECT only on safe columns (no fingerprint hash)', () => {
    // The column-list grant must NOT include device_fingerprint_hash.
    const grantBlock = migration.match(/GRANT SELECT \(([\s\S]*?)\) ON public\.trusted_devices TO authenticated/);
    expect(grantBlock, 'safe column GRANT must exist').not.toBeNull();
    expect(grantBlock[1]).not.toMatch(/device_fingerprint_hash/);
    expect(grantBlock[1]).toMatch(/device_label/);
  });

  it('defines the is_trusted_device_revoked deny-list helper', () => {
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.is_trusted_device_revoked/);
    expect(migration).toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(/GRANT\s+EXECUTE ON FUNCTION public\.is_trusted_device_revoked\(UUID, TEXT\) TO service_role/);
  });
});

describe('frontend wiring', () => {
  const deviceSessions = readFileSync(
    resolve(process.cwd(), 'src/lib/security/deviceSessions.js'),
    'utf8',
  );
  const securityCentre = readFileSync(
    resolve(process.cwd(), 'src/pages/SecurityCentre.jsx'),
    'utf8',
  );
  const deviceTrustPanel = readFileSync(
    resolve(process.cwd(), 'src/components/security/DeviceTrustPanel.jsx'),
    'utf8',
  );

  it('client lib only calls security-devices via supabase.functions.invoke', () => {
    expect(deviceSessions).toMatch(/SECURITY_DEVICES_FUNCTION_NAME\s*=\s*FUNCTION_NAME/);
    expect(deviceSessions).toMatch(/functions\.invoke\(\s*FUNCTION_NAME/);
    expect(deviceSessions).toMatch(/list_devices/);
    expect(deviceSessions).toMatch(/revoke_device/);
  });

  it('SecurityCentre Sessions tab calls revokeDeviceServer', () => {
    expect(securityCentre).toMatch(/revokeDeviceServer/);
    expect(securityCentre).toMatch(/listServerDevices|listDevices as listServerDevices/);
  });

  it('SecurityCentre still surfaces the active-session limitation honestly', () => {
    expect(securityCentre).toMatch(/active session may remain|refresh token expires/i);
  });

  it('DeviceTrustPanel calls the server-backed revoke and keeps honest copy', () => {
    expect(deviceTrustPanel).toMatch(/revokeDeviceServer/);
    expect(deviceTrustPanel).toMatch(/Remote sessions are not signed out|refresh token expires/);
  });
});

describe('payment edge functions enforce the deny-list', () => {
  const completeStepUp = readFileSync(
    resolve(process.cwd(), 'supabase/functions/complete-step-up/index.ts'),
    'utf8',
  );
  const initiatePayment = readFileSync(
    resolve(process.cwd(), 'supabase/functions/initiate-payment/index.ts'),
    'utf8',
  );

  it('complete-step-up checks isClientDeviceRevoked before resuming', () => {
    expect(completeStepUp).toMatch(/isClientDeviceRevoked/);
    expect(completeStepUp).toMatch(/DEVICE_REVOKED/);
  });

  it('initiate-payment checks isClientDeviceRevoked before queuing the payment', () => {
    expect(initiatePayment).toMatch(/isClientDeviceRevoked/);
    expect(initiatePayment).toMatch(/DEVICE_REVOKED/);
  });
});
