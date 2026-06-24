-- INFO-7 (2026-06 money-path audit): remove the dead per-pending-payment
-- finalization lock.
--
-- `lock_pending_payment_for_finalization` was defined and granted in
-- 20260519110000_ledger_concurrency_hardening.sql but is never called by any
-- Edge Function, cron, or RPC. It implies a defense the call sites do not take.
-- The actual double-post defenses are already wired and sufficient:
--   * webhook_events.idempotency_key UNIQUE  (webhook-handler de-dup)
--   * the per-transaction_ref pg_advisory_xact_lock INSIDE post_double_entry
--   * the ledger_idempotency_keys result cache
-- Concurrent callbacks for one payment are serialized at the ledger layer
-- regardless, so we REMOVE the dead lock rather than wire an unused primitive in
-- (which would add risk for no benefit).
--
-- `payment_finalize_lock_key` is the lock's sole-purpose key helper (its only
-- caller was the function dropped above), so it is dropped as well.

DROP FUNCTION IF EXISTS public.lock_pending_payment_for_finalization(UUID);
DROP FUNCTION IF EXISTS public.payment_finalize_lock_key(UUID);
