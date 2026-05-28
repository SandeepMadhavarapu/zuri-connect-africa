/**
 * Zuri Connect Africa — Idempotency Engine
 * Production-grade 4-layer duplicate prevention:
 *   1. Local cache (sessionStorage + localStorage) — instant, no network
 *   2. Server check (Supabase idempotency_keys table)
 *   3. Atomic reservation (UNIQUE constraint = race-safe)
 *   4. Execution with completion tracking
 *
 * Prevents duplicate financial actions from double-taps, retries, lag spikes,
 * browser refreshes during submit, and concurrent requests.
 */

import { getIdempotencyStoragePrefix } from '@/lib/demoMode/index.js';
import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — safe for mobile retry patterns
const LOCAL_KEY_PREFIX = 'zuri_idem_';

// ============================================================
// KEY GENERATION
// ============================================================

export function generateIdempotencyKey(userId, action, amount) {
  const bucket = Math.floor(Date.now() / TTL_MS);
  const raw = `${userId}|${action}|${amount}|${bucket}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = (hash * 16777619) >>> 0;
  }
  return `${getIdempotencyStoragePrefix()}${action}_${hash.toString(16).padStart(8, '0')}`;
}

export function generateRandomIdempotencyKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `zuri_idem_${hex}`;
}

export async function hashRequest(payload) {
  const json = JSON.stringify(payload, Object.keys(payload).sort());
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(json));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================
// LAYER 1 — LOCAL CACHE
// ============================================================

export function checkIdempotency(key) {
  try {
    const raw = sessionStorage.getItem(key) || localStorage.getItem(LOCAL_KEY_PREFIX + key);
    if (!raw) return null;
    const record = JSON.parse(raw);
    if (Date.now() > record.expiresAt) {
      sessionStorage.removeItem(key);
      localStorage.removeItem(LOCAL_KEY_PREFIX + key);
      return null;
    }
    return record.result;
  } catch {
    return null;
  }
}

export function recordIdempotency(key, result, ttlMs = TTL_MS) {
  try {
    const record = {
      key,
      result,
      recordedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
    sessionStorage.setItem(key, JSON.stringify(record));
    try { localStorage.setItem(LOCAL_KEY_PREFIX + key, JSON.stringify(record)); } catch {}
  } catch {
    // storage full or unavailable — degrade gracefully
  }
}

export function clearExpiredKeys() {
  const now = Date.now();
  const toRemove = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key?.startsWith('zuri_idmp_') && !key?.startsWith('zuri_idem_')) continue;
    try {
      const record = JSON.parse(sessionStorage.getItem(key));
      if (now > record.expiresAt) toRemove.push(key);
    } catch {
      toRemove.push(key);
    }
  }
  toRemove.forEach((k) => sessionStorage.removeItem(k));
}

// ============================================================
// LAYER 2 + 3 — SUPABASE SERVER CHECK + ATOMIC RESERVATION
// ============================================================

export async function checkServerIdempotency(key) {
  try {
    const supabase = getSupabaseBrowserClient();
    const { data, error } = await supabase
      .from('idempotency_keys')
      .select('*')
      .eq('key', key)
      .maybeSingle();
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

export async function reserveServerIdempotency(key, operation, requestHash, ownerId) {
  try {
    const supabase = getSupabaseBrowserClient();
    const { error } = await supabase.from('idempotency_keys').insert({
      key,
      operation,
      request_hash: requestHash,
      owner_id: ownerId || null,
      status: 'pending',
    });
    if (error) return false;
    return true;
  } catch {
    return false;
  }
}

export async function completeServerIdempotency(key, responseData) {
  try {
    const supabase = getSupabaseBrowserClient();
    await supabase
      .from('idempotency_keys')
      .update({
        status: 'completed',
        response_data: responseData,
        completed_at: new Date().toISOString(),
      })
      .eq('key', key);
  } catch {}
}

export async function failServerIdempotency(key) {
  try {
    const supabase = getSupabaseBrowserClient();
    await supabase.from('idempotency_keys').update({ status: 'failed' }).eq('key', key);
  } catch {}
}

// ============================================================
// LAYER 4 — FULL IDEMPOTENT OPERATION WRAPPER
// ============================================================

/**
 * Backward-compatible local-only wrapper.
 */
export async function withIdempotency(key, fn) {
  const existing = checkIdempotency(key);
  if (existing) {
    console.info(`[Idempotency] Local replay — key ${key}`);
    return { ...existing, replayed: true };
  }
  const result = await fn();
  recordIdempotency(key, result);
  return result;
}

/**
 * Production-grade 4-layer idempotent operation wrapper.
 */
export async function withIdempotencyFull(key, operation, payload, ownerId, fn) {
  if (!key) throw new Error('Idempotency key required');

  const requestHash = await hashRequest(payload);

  // LAYER 1 — local cache
  const local = checkIdempotency(key);
  if (local && local.requestHash === requestHash) {
    console.info(`[Idempotency] L1 local hit — ${key}`);
    return { ...local, idempotent: true, layer: 'local' };
  }
  if (local && local.requestHash && local.requestHash !== requestHash) {
    throw new Error('Idempotency key reused with different payload');
  }

  // LAYER 2 — server check
  const server = await checkServerIdempotency(key);
  if (server && server.status === 'completed') {
    if (server.request_hash !== requestHash) {
      throw new Error('Idempotency key reused with different payload');
    }
    const cached = server.response_data || {};
    recordIdempotency(key, { ...cached, requestHash });
    console.info(`[Idempotency] L2 server hit — ${key}`);
    return { ...cached, idempotent: true, layer: 'server' };
  }

  // LAYER 3 — atomic reservation
  const reserved = await reserveServerIdempotency(key, operation, requestHash, ownerId);
  if (!reserved) {
    throw new Error('Operation already in progress with this key');
  }

  // LAYER 4 — execute
  try {
    const result = await fn();
    await completeServerIdempotency(key, result);
    recordIdempotency(key, { ...result, requestHash });
    return result;
  } catch (err) {
    await failServerIdempotency(key);
    throw err;
  }
}
