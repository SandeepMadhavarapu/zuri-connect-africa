-- WebAuthn credential and challenge storage.
-- Replaces sessionStorage enrollment — credentials now survive tab close and are
-- protected by RLS rather than being exposed to XSS.

-- ── Credentials ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id    TEXT        NOT NULL UNIQUE,
  public_key_spki  TEXT        NOT NULL,   -- base64-encoded SubjectPublicKeyInfo
  algorithm        INTEGER     NOT NULL DEFAULT -7,  -- COSE: -7=ES256, -257=RS256
  sign_count       INTEGER     NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webauthn_cred_user
  ON public.webauthn_credentials (user_id);

ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_credentials FORCE ROW LEVEL SECURITY;

-- Service role manages all rows; user can read their own.
CREATE POLICY "webauthn_cred_service_all"
  ON public.webauthn_credentials FOR ALL
  USING  (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "webauthn_cred_user_read"
  ON public.webauthn_credentials FOR SELECT
  USING (auth.uid() = user_id);

-- ── Challenges ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  challenge  TEXT        NOT NULL,   -- base64url-encoded 32-byte random bytes
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenge_user
  ON public.webauthn_challenges (user_id, expires_at);

ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_challenges FORCE ROW LEVEL SECURITY;

CREATE POLICY "webauthn_challenge_service_all"
  ON public.webauthn_challenges FOR ALL
  USING  (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Cleanup function — called by the edge function and can be scheduled via pg_cron.
CREATE OR REPLACE FUNCTION public.cleanup_expired_webauthn_challenges()
RETURNS INTEGER AS $$
DECLARE deleted INTEGER;
BEGIN
  DELETE FROM public.webauthn_challenges WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON TABLE public.webauthn_credentials IS 'Server-side WebAuthn credential store. Public keys (SPKI) and signCounts are authoritative here.';
COMMENT ON TABLE public.webauthn_challenges  IS 'Single-use WebAuthn challenge tokens. Deleted immediately after verification to prevent replay.';
