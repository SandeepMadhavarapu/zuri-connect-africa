-- ============================================================
-- Zuri Connect Africa — OTP records hardening
-- ============================================================
-- Adds purpose binding, modern expiry/consumed columns, and an
-- atomic single-shot verification RPC so two concurrent requests
-- can never both consume the same one-time code (TOCTOU close).
--
-- Backward compatibility:
--   * `otp_hash` column is preserved. New code stores a peppered
--     HMAC (OTP_PEPPER, "${purpose}:${normalizedPhone}:${otp}").
--   * `expiry` (bigint ms) column is preserved alongside the new
--     `expires_at` (timestamptz). `consume_otp` enforces whichever
--     is set.
--   * Pre-existing rows (legacy SHA-256 hashes) will simply fail
--     to match the new HMAC and expire normally within 5 minutes.
--
-- No browser client ever reads/writes this table — it stays
-- service_role-only (see 20260511150000_rls_lockdown.sql).
-- ============================================================

-- ── Schema additions ────────────────────────────────────────
ALTER TABLE public.otp_records
  ADD COLUMN IF NOT EXISTS purpose          TEXT        NOT NULL DEFAULT 'verification',
  ADD COLUMN IF NOT EXISTS expires_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consumed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS verified_user_id UUID,
  ADD COLUMN IF NOT EXISTS hash_version     TEXT        NOT NULL DEFAULT 'sha256_legacy_v0';

-- Speeds up the "latest active OTP for this phone+purpose" lookup
-- that consume_otp performs.
CREATE INDEX IF NOT EXISTS idx_otp_records_phone_purpose_active
  ON public.otp_records (phone, purpose, consumed_at, created_at DESC);

COMMENT ON COLUMN public.otp_records.purpose IS
  'OTP purpose binding (verification | step_up | pin_setup | pin_reset). Hashed into otp_hash; a code minted for one purpose cannot be replayed against another.';
COMMENT ON COLUMN public.otp_records.expires_at IS
  'Authoritative expiry (timestamptz). Older rows still use the legacy `expiry` bigint column; consume_otp enforces whichever is set.';
COMMENT ON COLUMN public.otp_records.consumed_at IS
  'Set atomically by consume_otp() on successful verification. Once set, the row can never verify again.';
COMMENT ON COLUMN public.otp_records.verified_user_id IS
  'The auth.users.id that successfully consumed this OTP (when the verify request carried a valid bearer token).';
COMMENT ON COLUMN public.otp_records.hash_version IS
  'Hash scheme used for otp_hash. "hmac_sha256_pepper_v1" = peppered HMAC over (purpose:phone:otp). "sha256_legacy_v0" = pre-hardening row, kept only until expiry.';

-- ── Atomic single-use verification RPC ──────────────────────
-- SECURITY DEFINER so Edge Functions (service_role) can call it
-- without needing direct table grants. Idempotent re-runs are
-- safe — only the function body changes.
CREATE OR REPLACE FUNCTION public.consume_otp(
  p_phone        TEXT,
  p_purpose      TEXT,
  p_hash         TEXT,
  p_max_attempts INTEGER DEFAULT 3,
  p_user_id      UUID    DEFAULT NULL
)
RETURNS TABLE (
  record_id        UUID,
  attempts_after   INTEGER,
  outcome          TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record  public.otp_records%ROWTYPE;
  v_now     TIMESTAMPTZ := now();
  v_now_ms  BIGINT      := (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;
BEGIN
  IF p_phone IS NULL OR length(p_phone) = 0 THEN
    record_id := NULL; attempts_after := 0; outcome := 'invalid_input'; RETURN NEXT; RETURN;
  END IF;
  IF p_hash IS NULL OR length(p_hash) < 32 THEN
    record_id := NULL; attempts_after := 0; outcome := 'invalid_input'; RETURN NEXT; RETURN;
  END IF;

  -- Lock the latest un-consumed record for this phone+purpose so two
  -- concurrent callers cannot both succeed.
  SELECT *
    INTO v_record
    FROM public.otp_records
    WHERE phone = p_phone
      AND COALESCE(purpose, 'verification') = COALESCE(p_purpose, 'verification')
      AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    record_id := NULL; attempts_after := 0; outcome := 'not_found'; RETURN NEXT; RETURN;
  END IF;

  -- Expiry — accept either column.
  IF (v_record.expires_at IS NOT NULL AND v_record.expires_at <= v_now)
     OR (v_record.expires_at IS NULL AND v_record.expiry IS NOT NULL AND v_record.expiry <= v_now_ms) THEN
    DELETE FROM public.otp_records WHERE id = v_record.id;
    record_id := v_record.id; attempts_after := COALESCE(v_record.attempts, 0); outcome := 'expired';
    RETURN NEXT; RETURN;
  END IF;

  -- Attempt cap (anti brute-force).
  IF COALESCE(v_record.attempts, 0) >= p_max_attempts THEN
    record_id := v_record.id; attempts_after := v_record.attempts; outcome := 'locked';
    RETURN NEXT; RETURN;
  END IF;

  -- Hash mismatch — atomically bump attempts.
  IF v_record.otp_hash IS DISTINCT FROM p_hash THEN
    UPDATE public.otp_records
      SET attempts = COALESCE(attempts, 0) + 1
      WHERE id = v_record.id;
    record_id := v_record.id;
    attempts_after := COALESCE(v_record.attempts, 0) + 1;
    outcome := 'invalid';
    RETURN NEXT; RETURN;
  END IF;

  -- Hash matches — atomically claim. The WHERE clause prevents a race
  -- with any concurrent caller that may have already consumed it.
  UPDATE public.otp_records
    SET consumed_at = v_now,
        verified_user_id = COALESCE(p_user_id, verified_user_id)
    WHERE id = v_record.id
      AND consumed_at IS NULL;

  IF NOT FOUND THEN
    record_id := v_record.id; attempts_after := v_record.attempts; outcome := 'already_consumed';
    RETURN NEXT; RETURN;
  END IF;

  record_id := v_record.id; attempts_after := v_record.attempts; outcome := 'consumed';
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_otp(TEXT, TEXT, TEXT, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_otp(TEXT, TEXT, TEXT, INTEGER, UUID) TO service_role;

COMMENT ON FUNCTION public.consume_otp(TEXT, TEXT, TEXT, INTEGER, UUID) IS
  'Atomic single-use OTP verification. Locks the latest un-consumed row for the (phone, purpose) pair, validates expiry and attempt budget, then either marks consumed_at or increments attempts in a single transaction. Returns outcome in {consumed, invalid, expired, locked, already_consumed, not_found, invalid_input}.';

-- ── Hygiene: purge old consumed/expired rows occasionally ───
-- (Application logic still deletes on expiry/consume; this function lets
--  operators run a cheap cron to keep the table tiny.)
CREATE OR REPLACE FUNCTION public.purge_stale_otp_records(p_grace_minutes INTEGER DEFAULT 60)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- PL/pgSQL forbids expressions inside GET DIAGNOSTICS, so we accumulate
  -- ROW_COUNT through a scratch variable on each DELETE.
  v_deleted       INTEGER := 0;
  v_batch_deleted INTEGER := 0;
BEGIN
  DELETE FROM public.otp_records
    WHERE consumed_at IS NOT NULL
      AND consumed_at < now() - make_interval(mins => p_grace_minutes);

  GET DIAGNOSTICS v_batch_deleted = ROW_COUNT;
  v_deleted := v_deleted + v_batch_deleted;

  DELETE FROM public.otp_records
    WHERE (expires_at IS NOT NULL AND expires_at < now() - make_interval(mins => p_grace_minutes))
       OR (expires_at IS NULL AND expiry IS NOT NULL
           AND expiry < ((EXTRACT(EPOCH FROM now()) * 1000)::BIGINT - p_grace_minutes * 60 * 1000));

  GET DIAGNOSTICS v_batch_deleted = ROW_COUNT;
  v_deleted := v_deleted + v_batch_deleted;

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_stale_otp_records(INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_stale_otp_records(INTEGER) TO service_role;

COMMENT ON FUNCTION public.purge_stale_otp_records(INTEGER) IS
  'Service-only hygiene helper. Removes consumed/expired OTP rows older than the supplied grace window. Safe to schedule via pg_cron.';
