-- Phase 6.2 prerequisite: bring notifications up to worker spec.
-- Adds the columns the notification-worker needs, fixes the status
-- default + adds a CHECK constraint, and adds a partial index for
-- the worker's batch-claim query.

BEGIN;

-- Step 1 — Backfill any legacy 'pending' rows to 'queued' BEFORE
-- adding the CHECK (CHECK won't permit 'pending').
UPDATE public.notifications
SET status = 'queued'
WHERE status = 'pending';

-- Step 2 — Add new columns. ADD COLUMN IF NOT EXISTS for idempotency.
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS to_address        TEXT,
  ADD COLUMN IF NOT EXISTS retry_count       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sent_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failed_reason     TEXT;

-- Step 3 — Change status default from 'pending' to 'queued'.
ALTER TABLE public.notifications
  ALTER COLUMN status SET DEFAULT 'queued';

-- Step 4 — Add CHECK constraint on status. Drop first for idempotency.
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_status_chk;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_status_chk
  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'permanently_failed'));

-- Step 5 — Partial index for the worker's batch-claim query.
CREATE INDEX IF NOT EXISTS idx_notifications_queued_or_sending
  ON public.notifications (created_at)
  WHERE status IN ('queued', 'sending');

COMMIT;
