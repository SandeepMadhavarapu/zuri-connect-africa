-- Add user_id to pending_payments so per-user rate limiting and ownership checks work.
-- The initiate-payment edge function already writes user_id on every new row.
-- Historical rows (if any) remain NULL; all future rows will have the column set.

ALTER TABLE public.pending_payments
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_pending_payments_user_created
  ON public.pending_payments (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

COMMENT ON COLUMN public.pending_payments.user_id IS
  'The authenticated Supabase user who initiated the STK Push. Set by the initiate-payment edge function; MUST NOT be NULL for new rows.';
