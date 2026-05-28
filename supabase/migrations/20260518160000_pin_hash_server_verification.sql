-- Server-side PIN verification for payment step-up (complete-step-up).
-- Clients may upsert only their own pin_hash; verification reads via service_role.

ALTER TABLE public.pin_hash_metadata
  ADD COLUMN IF NOT EXISTS pin_hash TEXT;

COMMENT ON COLUMN public.pin_hash_metadata.pin_hash IS
  'PBKDF2-SHA256 hash (salt_hex:hash_hex). Used by complete-step-up for pin challenges only; never logged.';

CREATE POLICY "pin_hash_metadata_upsert_own"
  ON public.pin_hash_metadata FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "pin_hash_metadata_update_own"
  ON public.pin_hash_metadata FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

GRANT INSERT, UPDATE (pin_hash, hash_version, upgraded_at) ON public.pin_hash_metadata TO authenticated;
