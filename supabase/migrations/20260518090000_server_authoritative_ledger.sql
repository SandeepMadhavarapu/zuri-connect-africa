-- Server-authoritative money movement hardening.
-- Browser clients must never insert, update, delete, or RPC-post financial ledger rows.

ALTER TABLE IF EXISTS public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ledger_entries FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'ledger_entries'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.ledger_entries', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "ledger_entries_select_own"
  ON public.ledger_entries
  FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid()::text);

CREATE POLICY "ledger_entries_service_role_all"
  ON public.ledger_entries
  FOR ALL
  TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE INSERT, UPDATE, DELETE ON public.ledger_entries FROM anon, authenticated;
GRANT SELECT ON public.ledger_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_entries TO service_role;

REVOKE EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) TO service_role;

DO $$
BEGIN
  IF to_regprocedure('public.post_double_entry(jsonb,jsonb)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB) TO service_role;
  END IF;
END $$;

COMMENT ON TABLE public.ledger_entries IS
  'Append-only financial ledger. Browser clients must never write rows; only Supabase Edge Functions using service_role may post money movement after provider confirmation.';

COMMENT ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) IS
  'Server-only atomic double-entry ledger write. EXECUTE is revoked from browser roles; Supabase Edge Functions call this with service_role after Daraja callback confirmation.';

ALTER TABLE IF EXISTS public.pending_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.pending_payments FORCE ROW LEVEL SECURITY;

ALTER TABLE public.pending_payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'send',
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS provider_receipt TEXT,
  ADD COLUMN IF NOT EXISTS callback_payload_hash TEXT,
  ADD COLUMN IF NOT EXISTS raw_callback JSONB,
  ADD COLUMN IF NOT EXISTS ledger_posted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_payments_idempotency_key
  ON public.pending_payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pending_payments_status_updated
  ON public.pending_payments(status, updated_at DESC);

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pending_payments'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.pending_payments', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "pending_payments_select_own"
  ON public.pending_payments
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "pending_payments_service_role_all"
  ON public.pending_payments
  FOR ALL
  TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE INSERT, UPDATE, DELETE ON public.pending_payments FROM anon, authenticated;
GRANT SELECT ON public.pending_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_payments TO service_role;

COMMENT ON TABLE public.pending_payments IS
  'Daraja STK Push lifecycle records. Browser clients may read only their own payment status; writes are service_role-only from Supabase Edge Functions.';

COMMENT ON COLUMN public.pending_payments.ledger_posted_at IS
  'Set only after webhook-handler verifies a successful Daraja callback and posts the service-role double-entry ledger rows.';
