-- Idempotency key tracking for transactions
-- Prevents duplicate ledger entries from double-submits, network retries,
-- and concurrent requests at the database level

CREATE TABLE IF NOT EXISTS public.idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  owner_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_data JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_key ON public.idempotency_keys(key);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_owner ON public.idempotency_keys(owner_id);
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires ON public.idempotency_keys(expires_at);

-- Enable RLS so users can only see their own keys
ALTER TABLE public.idempotency_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own idempotency keys" ON public.idempotency_keys;
CREATE POLICY "Users can view own idempotency keys"
  ON public.idempotency_keys FOR SELECT
  USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own idempotency keys" ON public.idempotency_keys;
CREATE POLICY "Users can insert own idempotency keys"
  ON public.idempotency_keys FOR INSERT
  WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own idempotency keys" ON public.idempotency_keys;
CREATE POLICY "Users can update own idempotency keys"
  ON public.idempotency_keys FOR UPDATE
  USING (owner_id = auth.uid());

-- Cleanup function for expired keys
CREATE OR REPLACE FUNCTION public.cleanup_expired_idempotency_keys()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.idempotency_keys
  WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Add idempotency_key column to ledger_entries if it doesn't exist
ALTER TABLE public.ledger_entries
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_idempotency_key
  ON public.ledger_entries(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON TABLE public.idempotency_keys IS 'Idempotency tracking for financial operations. Keys expire after 24h.';
