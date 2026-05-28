-- Tracks PIN hash algorithm version per user.
-- Allows the app to detect whether a user is on legacy SHA-256
-- or the current PBKDF2-SHA256-v1 scheme.
-- NOTE: writes to this table are handled at the application layer
-- when a user sets or resets their PIN. This migration only
-- creates the schema.

CREATE TABLE IF NOT EXISTS public.pin_hash_metadata (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  hash_version TEXT        NOT NULL DEFAULT 'pbkdf2_sha256_v1',
  upgraded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.pin_hash_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_hash_metadata FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pin_hash_metadata_own" ON public.pin_hash_metadata;

CREATE POLICY "pin_hash_metadata_own"
  ON public.pin_hash_metadata
  FOR ALL
  USING  (user_id = auth.uid() OR auth.role() = 'service_role')
  WITH CHECK (user_id = auth.uid() OR auth.role() = 'service_role');

COMMENT ON TABLE public.pin_hash_metadata IS
  'Tracks PIN hash algorithm version per user. Legacy = sha256_static_salt. Current = pbkdf2_sha256_v1.';
