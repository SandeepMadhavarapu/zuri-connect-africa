-- ============================================================
-- TRUSTED DEVICES — server-authoritative device trust + revoke
-- ============================================================
--
-- Backend-backed device trust + remote revocation. The browser used to keep
-- a localStorage-only registry (`zuri_trusted_devices_v2`); that registry is
-- preserved as a UX cache but is no longer the source of truth.
--
-- Trust boundary:
--   * The client knows a SHORT non-PII fingerprint id (`fp_<8 hex>`) computed
--     from browser signals. It NEVER sees the stored row's hash.
--   * The Edge Function pepper-hashes the fingerprint id with the secret
--     `DEVICE_FINGERPRINT_PEPPER` and stores the resulting `device_fingerprint_hash`.
--   * RLS lets a user read their own safe device summaries; the service role
--     manages writes and exposes mutations only through the
--     `security-devices` Edge Function.
--   * `revoked_at` is the authoritative deny-list. Other Edge Functions can
--     call `public.is_trusted_device_revoked(...)` as a fast pre-flight before
--     completing any sensitive action.
--
-- ============================================================

CREATE TABLE IF NOT EXISTS public.trusted_devices (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_label             TEXT        NOT NULL DEFAULT 'Device',
  device_fingerprint_hash  TEXT        NOT NULL,
  webauthn_credential_id   UUID        REFERENCES public.webauthn_credentials(id) ON DELETE SET NULL,
  last_seen_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  trusted                  BOOLEAN     NOT NULL DEFAULT TRUE,
  revoked_at               TIMESTAMPTZ,
  revoked_reason           TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT trusted_devices_label_length      CHECK (char_length(device_label) BETWEEN 1 AND 60),
  CONSTRAINT trusted_devices_hash_format       CHECK (device_fingerprint_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT trusted_devices_revoked_reason_safe CHECK (
    revoked_reason IS NULL
    OR revoked_reason IN ('user_revoked', 'service_revoked', 'all_other_devices', 'admin_revoked', 'sim_swap_critical')
  )
);

-- One ACTIVE row per (user, fingerprint hash). Revoked rows can stack so we
-- preserve an audit trail of past revocations.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trusted_devices_user_active
  ON public.trusted_devices (user_id, device_fingerprint_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trusted_devices_user_active
  ON public.trusted_devices (user_id, revoked_at);

CREATE INDEX IF NOT EXISTS idx_trusted_devices_last_seen
  ON public.trusted_devices (user_id, last_seen_at DESC);

COMMENT ON TABLE  public.trusted_devices IS
  'Server-authoritative trusted-device registry. Service role manages mutations via the security-devices Edge Function. Browser reads its own safe rows only — never the raw fingerprint hash.';
COMMENT ON COLUMN public.trusted_devices.device_fingerprint_hash IS
  'SHA-256(pepper || fingerprint_id). The raw fingerprint id is never stored.';

-- ============================================================
-- RLS — service writes, user reads own safe rows
-- ============================================================

ALTER TABLE public.trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_devices FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.trusted_devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.trusted_devices TO service_role;

-- Drop any prior policies before recreating (idempotent).
DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'trusted_devices'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.trusted_devices', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "trusted_devices_service_role_all"
  ON public.trusted_devices
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated users can SEE their own rows (so a self-list query works), but
-- the raw fingerprint hash is column-level revoked so it never leaks.
CREATE POLICY "trusted_devices_select_own"
  ON public.trusted_devices
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Authenticated callers can read only safe columns. The fingerprint hash is
-- intentionally OMITTED — the column-level GRANT is the security boundary, RLS
-- alone does not hide individual columns from a SELECT *.
GRANT SELECT (
  id, user_id, device_label, last_seen_at, trusted,
  revoked_at, revoked_reason, webauthn_credential_id, created_at
) ON public.trusted_devices TO authenticated;

-- ============================================================
-- Deny-list helper — invoked by other Edge Functions
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_trusted_device_revoked(
  p_user_id            UUID,
  p_fingerprint_hash   TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.trusted_devices
    WHERE user_id = p_user_id
      AND device_fingerprint_hash = p_fingerprint_hash
      AND revoked_at IS NOT NULL
  );
$$;

REVOKE EXECUTE ON FUNCTION public.is_trusted_device_revoked(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.is_trusted_device_revoked(UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.is_trusted_device_revoked IS
  'Fast deny-list check. Returns TRUE if (user_id, fingerprint_hash) has ANY revoked row. Service role only.';
