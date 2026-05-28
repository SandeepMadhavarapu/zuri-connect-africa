-- Webhook nonce tracking — prevents replay attacks
-- Every accepted webhook records its signature so the same payload
-- can never be processed twice, even if intercepted and replayed.

CREATE TABLE IF NOT EXISTS public.webhook_nonces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  signature TEXT NOT NULL,
  nonce TEXT,
  payload_hash TEXT NOT NULL,
  source_ip TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  UNIQUE(provider, signature)
);

CREATE INDEX IF NOT EXISTS idx_webhook_nonces_provider_sig 
  ON public.webhook_nonces(provider, signature);
CREATE INDEX IF NOT EXISTS idx_webhook_nonces_expires 
  ON public.webhook_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_webhook_nonces_payload_hash
  ON public.webhook_nonces(payload_hash);

ALTER TABLE public.webhook_nonces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages webhook nonces" ON public.webhook_nonces;
CREATE POLICY "Service role manages webhook nonces"
  ON public.webhook_nonces FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.cleanup_expired_webhook_nonces()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM public.webhook_nonces WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.webhook_nonces IS 'Replay-protection for webhook signatures. Retained 7 days.';
