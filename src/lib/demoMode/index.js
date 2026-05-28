/**
 * Safe demo / degraded mode when Supabase URL + anon key are not production-valid.
 * Does not simulate authenticated production users; isolates session-scoped idempotency keys.
 */

import { isSupabaseConfigured } from '@/config/env.js';

/**
 * True when the app is allowed to run without real Supabase (local dev or explicit demo fallback).
 * Never true for strict production builds that passed startup with real keys.
 */
export function isDemoFallbackActive() {
  if (typeof import.meta === 'undefined') return false;
  if (isSupabaseConfigured) return false;
  return import.meta.env.VITE_DEMO_FALLBACK !== 'false';
}

/**
 * Merge into telemetry payloads so dashboards can exclude non-production traffic.
 */
export function demoTelemetryDimensions() {
  return isDemoFallbackActive() ? { demo_fallback: '1' } : {};
}

/**
 * Prefix for sessionStorage-scoped financial idempotency keys (see idempotency.js).
 */
export function getIdempotencyStoragePrefix() {
  return isDemoFallbackActive() ? 'zuri_idmp_demo_' : 'zuri_idmp_';
}
