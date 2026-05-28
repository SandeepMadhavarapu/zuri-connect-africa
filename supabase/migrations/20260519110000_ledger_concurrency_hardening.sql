-- =============================================================================
-- Ledger concurrency hardening — per-transaction_ref advisory lock,
-- idempotency result cache, per-pending-payment finalization lock.
--
-- Strict additive change. Does NOT alter existing column shape, RLS, or the
-- public JSON return shape of post_double_entry. The only behaviour changes:
--
--   1. post_double_entry serialises calls with the same transaction_ref so
--      concurrent retries cannot both claim distinct chain slots, then have
--      one collapse via ON CONFLICT (which previously left chain_index gaps).
--   2. Completed posts are cached in ledger_idempotency_keys so idempotent
--      replays return the exact original JSON without touching chain head.
--   3. lock_pending_payment_for_finalization gives the webhook + admin retry
--      a single, safe way to serialise concurrent callbacks for one payment.
--
-- All locks are pg_advisory_xact_lock — auto-released on COMMIT or ROLLBACK
-- so a failed post never leaves the row globally blocked.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. Idempotency cache table ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.ledger_idempotency_keys (
  key             TEXT PRIMARY KEY,
  transaction_ref TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'processing'
                  CHECK (status IN ('processing', 'completed', 'failed')),
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ledger_idempotency_keys_tx_ref
  ON public.ledger_idempotency_keys (transaction_ref);
CREATE INDEX IF NOT EXISTS idx_ledger_idempotency_keys_status
  ON public.ledger_idempotency_keys (status)
  WHERE status <> 'completed';

ALTER TABLE public.ledger_idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_idempotency_keys FORCE ROW LEVEL SECURITY;

DO $$
DECLARE p record;
BEGIN
  FOR p IN SELECT policyname FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'ledger_idempotency_keys'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.ledger_idempotency_keys', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "ledger_idempotency_keys_service_role_only"
  ON public.ledger_idempotency_keys
  FOR ALL TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON public.ledger_idempotency_keys FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_idempotency_keys TO service_role;

COMMENT ON TABLE public.ledger_idempotency_keys IS
  'Service-role-only idempotency cache for post_double_entry. Replays of a completed key return the original JSON result without re-running ledger inserts or claiming new chain indices.';

-- ── 2. Stable bigint advisory key derivation ────────────────────────────────

CREATE OR REPLACE FUNCTION public.ledger_tx_lock_key(p_tx_ref TEXT)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT hashtextextended('zuri.ledger.tx:' || COALESCE(p_tx_ref, ''), 0);
$$;

REVOKE ALL ON FUNCTION public.ledger_tx_lock_key(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ledger_tx_lock_key(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.payment_finalize_lock_key(p_id UUID)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  SELECT hashtextextended('zuri.payment.finalize:' || COALESCE(p_id::TEXT, ''), 0);
$$;

REVOKE ALL ON FUNCTION public.payment_finalize_lock_key(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payment_finalize_lock_key(UUID) TO service_role;

-- ── 3. Webhook finalization advisory lock helper ─────────────────────────────

CREATE OR REPLACE FUNCTION public.lock_pending_payment_for_finalization(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'lock_pending_payment_for_finalization is service_role only';
  END IF;
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'lock_pending_payment_for_finalization requires p_id';
  END IF;
  PERFORM pg_advisory_xact_lock(public.payment_finalize_lock_key(p_id));
END;
$$;

REVOKE ALL ON FUNCTION public.lock_pending_payment_for_finalization(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_pending_payment_for_finalization(UUID) TO service_role;

COMMENT ON FUNCTION public.lock_pending_payment_for_finalization IS
  'Per-pending-payment xact advisory lock. Held until COMMIT/ROLLBACK so concurrent webhook finalisations or admin retries on the same row cannot race into double ledger posting.';

-- ── 4. post_double_entry: advisory lock + idempotency cache ─────────────────

CREATE OR REPLACE FUNCTION public.post_double_entry(
  p_debit                       JSONB,
  p_credit                      JSONB,
  p_expect_debit_balance_before NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_debit_row         ledger_entries%ROWTYPE;
  v_credit_row        ledger_entries%ROWTYPE;
  v_current_balance   NUMERIC;
  v_debit_account_id  UUID;
  v_credit_account_id UUID;
  v_chain_scope       TEXT := 'global';
  v_slot              RECORD;
  v_prev_hash         TEXT;
  v_entry_hash        TEXT;
  v_tx_ref            TEXT;
  v_idem_key          TEXT;
  v_cached            public.ledger_idempotency_keys%ROWTYPE;
  v_result            JSONB;
BEGIN
  -- ── Validation ────────────────────────────────────────────────────────────
  v_tx_ref := p_debit->>'transaction_ref';

  IF v_tx_ref IS NULL OR v_tx_ref = '' THEN
    RAISE EXCEPTION 'LEDGER_INVALID: debit missing transaction_ref';
  END IF;

  IF (p_credit->>'transaction_ref') IS NULL OR (p_credit->>'transaction_ref') = '' THEN
    RAISE EXCEPTION 'LEDGER_INVALID: credit missing transaction_ref';
  END IF;

  IF v_tx_ref <> (p_credit->>'transaction_ref') THEN
    RAISE EXCEPTION 'LEDGER_PAIR: debit and credit transaction_ref must match';
  END IF;

  IF (p_debit->>'amount')::NUMERIC <> (p_credit->>'amount')::NUMERIC THEN
    RAISE EXCEPTION 'LEDGER_PAIR: debit amount % does not match credit amount %',
      p_debit->>'amount', p_credit->>'amount';
  END IF;

  v_idem_key := COALESCE(NULLIF(p_debit->>'idempotency_key', ''), v_tx_ref);

  -- ── 1. Acquire per-transaction_ref xact advisory lock ─────────────────────
  -- pg_advisory_xact_lock auto-releases at COMMIT or ROLLBACK, so a failure
  -- (RAISE EXCEPTION below, deadlock, network drop) never leaves it dangling.
  PERFORM pg_advisory_xact_lock(public.ledger_tx_lock_key(v_tx_ref));

  -- ── 2. Idempotency fast-path: return cached completed result ──────────────
  SELECT * INTO v_cached
  FROM public.ledger_idempotency_keys
  WHERE key = v_idem_key
  LIMIT 1;

  IF v_cached.status = 'completed' AND v_cached.result IS NOT NULL THEN
    RETURN v_cached.result;
  END IF;

  -- Mark this idempotency key as in-flight (re-entered safely on retry).
  INSERT INTO public.ledger_idempotency_keys (key, transaction_ref, status)
  VALUES (v_idem_key, v_tx_ref, 'processing')
  ON CONFLICT (key) DO UPDATE
    SET status = 'processing',
        transaction_ref = EXCLUDED.transaction_ref;

  -- ── 3. Optimistic balance lock (preserved behaviour) ──────────────────────
  IF p_expect_debit_balance_before IS NOT NULL THEN
    SELECT COALESCE(
      (
        SELECT balance_after
        FROM public.ledger_entries
        WHERE account_phone = p_debit->>'account_phone'
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ),
      0
    ) INTO v_current_balance;

    IF v_current_balance <> p_expect_debit_balance_before THEN
      RAISE EXCEPTION
        'LEDGER_RACE: balance changed. Expected % but found %. Retry the transaction.',
        p_expect_debit_balance_before, v_current_balance;
    END IF;
  END IF;

  v_debit_account_id  := public.resolve_ledger_leg_account(p_debit,  'debit');
  v_credit_account_id := public.resolve_ledger_leg_account(p_credit, 'credit');

  -- ── 4. Debit leg ─────────────────────────────────────────────────────────
  -- Under the advisory lock, no other transaction can be in this section for
  -- the same transaction_ref. The existence check below correctly distinguishes
  -- "fresh write" from "idempotent replay against the underlying table".
  SELECT * INTO v_debit_row
  FROM public.ledger_entries
  WHERE transaction_ref = v_tx_ref AND entry_type = 'debit'
  LIMIT 1;

  IF v_debit_row.id IS NULL THEN
    SELECT * INTO v_slot FROM public.claim_ledger_chain_slot(v_chain_scope);
    v_prev_hash := v_slot.previous_hash;

    v_entry_hash := public.compute_ledger_entry_hash(
      v_tx_ref,
      'debit',
      (p_debit->>'amount')::NUMERIC,
      (p_debit->>'balance_before')::NUMERIC,
      (p_debit->>'balance_after')::NUMERIC,
      p_debit->>'account_phone',
      v_debit_account_id,
      p_debit->>'idempotency_key',
      v_prev_hash
    );

    INSERT INTO public.ledger_entries (
      transaction_ref, entry_type, amount, balance_before, balance_after,
      account_phone, description, hash, owner_id, idempotency_key,
      account_id, debit_account_id, credit_account_id,
      previous_hash, entry_hash, chain_scope, chain_index
    ) VALUES (
      v_tx_ref, 'debit',
      (p_debit->>'amount')::NUMERIC,
      (p_debit->>'balance_before')::NUMERIC,
      (p_debit->>'balance_after')::NUMERIC,
      p_debit->>'account_phone',
      COALESCE(p_debit->>'description', ''),
      COALESCE(p_debit->>'hash', ''),
      p_debit->>'owner_id',
      p_debit->>'idempotency_key',
      v_debit_account_id, v_debit_account_id, NULL,
      v_prev_hash, v_entry_hash, v_chain_scope, v_slot.chain_index
    )
    ON CONFLICT (transaction_ref, entry_type)
      DO UPDATE SET transaction_ref = EXCLUDED.transaction_ref
    RETURNING * INTO v_debit_row;

    IF v_debit_row.entry_hash = v_entry_hash THEN
      PERFORM public.advance_ledger_chain_head(v_chain_scope, v_entry_hash);
    END IF;
  END IF;

  -- ── 5. Credit leg ─────────────────────────────────────────────────────────
  SELECT * INTO v_credit_row
  FROM public.ledger_entries
  WHERE transaction_ref = v_tx_ref AND entry_type = 'credit'
  LIMIT 1;

  IF v_credit_row.id IS NULL THEN
    v_prev_hash := COALESCE(
      v_debit_row.entry_hash,
      (SELECT h.last_entry_hash FROM public.ledger_chain_heads h WHERE h.chain_scope = v_chain_scope),
      public.ledger_genesis_hash()
    );

    SELECT * INTO v_slot FROM public.claim_ledger_chain_slot(v_chain_scope);

    v_entry_hash := public.compute_ledger_entry_hash(
      v_tx_ref,
      'credit',
      (p_credit->>'amount')::NUMERIC,
      (p_credit->>'balance_before')::NUMERIC,
      (p_credit->>'balance_after')::NUMERIC,
      p_credit->>'account_phone',
      v_credit_account_id,
      p_credit->>'idempotency_key',
      v_prev_hash
    );

    INSERT INTO public.ledger_entries (
      transaction_ref, entry_type, amount, balance_before, balance_after,
      account_phone, description, hash, owner_id, idempotency_key,
      account_id, debit_account_id, credit_account_id,
      previous_hash, entry_hash, chain_scope, chain_index
    ) VALUES (
      v_tx_ref, 'credit',
      (p_credit->>'amount')::NUMERIC,
      (p_credit->>'balance_before')::NUMERIC,
      (p_credit->>'balance_after')::NUMERIC,
      p_credit->>'account_phone',
      COALESCE(p_credit->>'description', ''),
      COALESCE(p_credit->>'hash', ''),
      p_credit->>'owner_id',
      p_credit->>'idempotency_key',
      v_credit_account_id, NULL, v_credit_account_id,
      v_prev_hash, v_entry_hash, v_chain_scope, v_slot.chain_index
    )
    ON CONFLICT (transaction_ref, entry_type)
      DO UPDATE SET transaction_ref = EXCLUDED.transaction_ref
    RETURNING * INTO v_credit_row;

    IF v_credit_row.entry_hash = v_entry_hash THEN
      PERFORM public.advance_ledger_chain_head(v_chain_scope, v_entry_hash);
    END IF;
  END IF;

  IF v_debit_row.id IS NULL OR v_credit_row.id IS NULL THEN
    -- Mark the cache as failed so a later caller knows to retry from scratch.
    UPDATE public.ledger_idempotency_keys
       SET status = 'failed', completed_at = now()
     WHERE key = v_idem_key;
    RAISE EXCEPTION 'LEDGER_CONFLICT: double-entry pair could not be written or retrieved';
  END IF;

  -- ── 6. Persist the result for fast idempotent replay ──────────────────────
  v_result := jsonb_build_object(
    'ok',                 true,
    'transaction_ref',    v_tx_ref,
    'debit_id',           v_debit_row.id,
    'credit_id',          v_credit_row.id,
    'debit_account_id',   v_debit_account_id,
    'credit_account_id',  v_credit_account_id,
    'debit_chain_index',  v_debit_row.chain_index,
    'credit_chain_index', v_credit_row.chain_index
  );

  INSERT INTO public.ledger_idempotency_keys (
    key, transaction_ref, status, result, completed_at
  ) VALUES (
    v_idem_key, v_tx_ref, 'completed', v_result, now()
  )
  ON CONFLICT (key) DO UPDATE
    SET status       = 'completed',
        result       = EXCLUDED.result,
        completed_at = EXCLUDED.completed_at;

  RETURN v_result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) TO service_role;

COMMENT ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) IS
  'Server-only atomic double-entry. Serialises concurrent calls per transaction_ref via pg_advisory_xact_lock; caches the JSON result in ledger_idempotency_keys so replays return the original result and never claim a new chain index. Advisory lock auto-releases on COMMIT/ROLLBACK.';
