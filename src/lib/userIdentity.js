/**
 * Stable ledger routing key for the signed-in user (Supabase profile).
 * Prefer MSISDN; fall back to email when phone metadata is absent.
 */

export function resolveLedgerIdentity(user) {
  return String(user?.phone || user?.email || '').trim();
}

/** Matches seeded demo ledger rows used before per-user profiles were wired. */
export const LEGACY_DEMO_LEDGER_KEY = '+254712345678';

export function resolveLedgerIdentityWithFallback(user) {
  const id = resolveLedgerIdentity(user);
  return id || LEGACY_DEMO_LEDGER_KEY;
}
