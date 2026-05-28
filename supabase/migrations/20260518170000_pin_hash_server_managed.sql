-- pin_hash is server-managed only. Browsers may read enrollment metadata, never the hash.

DROP POLICY IF EXISTS "pin_hash_metadata_upsert_own" ON public.pin_hash_metadata;
DROP POLICY IF EXISTS "pin_hash_metadata_update_own" ON public.pin_hash_metadata;

REVOKE INSERT, UPDATE ON public.pin_hash_metadata FROM authenticated;
REVOKE SELECT (pin_hash) ON public.pin_hash_metadata FROM authenticated;

DROP POLICY IF EXISTS "pin_hash_metadata_select_own" ON public.pin_hash_metadata;

CREATE POLICY "pin_hash_metadata_select_safe_own"
  ON public.pin_hash_metadata FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT (user_id, hash_version, upgraded_at) ON public.pin_hash_metadata TO authenticated;

COMMENT ON COLUMN public.pin_hash_metadata.pin_hash IS
  'Server-only PBKDF2 hash with PIN_PEPPER. Written exclusively by set-pin / service_role. Never exposed to browser roles.';

COMMENT ON TABLE public.pin_hash_metadata IS
  'PIN enrollment metadata. pin_hash is written only by the set-pin Edge Function using service_role.';
