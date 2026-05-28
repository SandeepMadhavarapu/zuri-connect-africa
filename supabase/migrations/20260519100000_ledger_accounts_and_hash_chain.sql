-- =============================================================================
-- Ledger account abstraction + tamper-evident hash chaining
-- Additive migration: preserves account_phone, hash, and existing RPC callers.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── 1. Accounts table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID REFERENCES auth.users (id) ON DELETE SET NULL,
  account_type        TEXT NOT NULL CHECK (account_type IN (
    'wallet', 'merchant', 'paybill', 'till', 'savings',
    'fuliza', 'settlement', 'suspense', 'fees'
  )),
  currency            TEXT NOT NULL DEFAULT 'KES',
  external_identifier TEXT,
  display_name        TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'suspended', 'closed'
  )),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id
  ON public.accounts (user_id)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_accounts_account_type
  ON public.accounts (account_type);

CREATE INDEX IF NOT EXISTS idx_accounts_external_identifier
  ON public.accounts (external_identifier)
  WHERE external_identifier IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_type_external_currency
  ON public.accounts (account_type, external_identifier, currency)
  WHERE external_identifier IS NOT NULL;

COMMENT ON TABLE public.accounts IS
  'Stable ledger account identities. Phone/paybill/till identifiers live in external_identifier; ledger_entries retain account_phone for backward compatibility.';

-- Seed immutable system accounts (no user_id).
INSERT INTO public.accounts (account_type, currency, external_identifier, display_name, status)
VALUES
  ('settlement', 'KES', 'SYSTEM:SETTLEMENT', 'Platform settlement', 'active'),
  ('suspense',   'KES', 'SYSTEM:SUSPENSE',   'Suspense / unmatched', 'active'),
  ('fees',       'KES', 'SYSTEM:FEES',       'Platform fees', 'active')
ON CONFLICT (account_type, external_identifier, currency)
  WHERE external_identifier IS NOT NULL
DO NOTHING;

-- ── 2. Ledger entry account references + chain columns ───────────────────────

ALTER TABLE public.ledger_entries
  ADD COLUMN IF NOT EXISTS account_id         UUID REFERENCES public.accounts (id),
  ADD COLUMN IF NOT EXISTS debit_account_id   UUID REFERENCES public.accounts (id),
  ADD COLUMN IF NOT EXISTS credit_account_id UUID REFERENCES public.accounts (id),
  ADD COLUMN IF NOT EXISTS previous_hash      TEXT,
  ADD COLUMN IF NOT EXISTS entry_hash         TEXT,
  ADD COLUMN IF NOT EXISTS chain_scope        TEXT,
  ADD COLUMN IF NOT EXISTS chain_index        BIGINT;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id
  ON public.ledger_entries (account_id)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ledger_entries_chain
  ON public.ledger_entries (chain_scope, chain_index)
  WHERE chain_index IS NOT NULL;

COMMENT ON COLUMN public.ledger_entries.account_id IS
  'Account affected by this row (debit or credit leg).';
COMMENT ON COLUMN public.ledger_entries.entry_hash IS
  'Tamper-evident chain hash over canonical fields + previous_hash. Legacy rows may be NULL.';
COMMENT ON COLUMN public.ledger_entries.hash IS
  'Legacy per-entry integrity hash (client/RPC). Preserved for backward compatibility.';

-- Atomic chain head per scope (global + optional per-account scopes later).
CREATE TABLE IF NOT EXISTS public.ledger_chain_heads (
  chain_scope       TEXT PRIMARY KEY,
  last_chain_index  BIGINT NOT NULL DEFAULT 0,
  last_entry_hash   TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.ledger_chain_heads (chain_scope)
VALUES ('global')
ON CONFLICT (chain_scope) DO NOTHING;

-- ── 3. Phone / external identifier normalization ───────────────────────────

CREATE OR REPLACE FUNCTION public.normalize_ledger_external_id(
  p_account_type        TEXT,
  p_external_identifier TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_raw TEXT;
  v_clean TEXT;
BEGIN
  v_raw := COALESCE(trim(p_external_identifier), '');
  IF v_raw = '' THEN
    RETURN NULL;
  END IF;

  IF p_account_type IN ('wallet', 'fuliza', 'savings', 'merchant') THEN
    v_clean := regexp_replace(v_raw, '\s+', '', 'g');
    v_clean := regexp_replace(v_clean, '^\+', '');
    IF v_clean ~ '^254' THEN
      RETURN v_clean;
    END IF;
    IF v_clean ~ '^07' OR v_clean ~ '^01' THEN
      RETURN '254' || substring(v_clean from 2);
    END IF;
    IF length(v_clean) = 9 AND (v_clean ~ '^7' OR v_clean ~ '^1') THEN
      RETURN '254' || v_clean;
    END IF;
    IF length(v_clean) = 10 AND v_clean ~ '^0' THEN
      RETURN '254' || substring(v_clean from 2);
    END IF;
    RETURN v_clean;
  END IF;

  RETURN upper(v_raw);
END;
$$;

-- ── 4. resolve_or_create_account (service_role only) ─────────────────────────

CREATE OR REPLACE FUNCTION public.resolve_or_create_account(
  p_account_type        TEXT,
  p_external_identifier TEXT,
  p_currency            TEXT DEFAULT 'KES',
  p_user_id             UUID DEFAULT NULL,
  p_display_name        TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type       TEXT;
  v_currency   TEXT;
  v_external   TEXT;
  v_account_id UUID;
  v_is_system  BOOLEAN;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'resolve_or_create_account is service_role only';
  END IF;

  v_type := lower(trim(COALESCE(p_account_type, 'wallet')));
  IF v_type NOT IN (
    'wallet', 'merchant', 'paybill', 'till', 'savings',
    'fuliza', 'settlement', 'suspense', 'fees'
  ) THEN
    RAISE EXCEPTION 'INVALID_ACCOUNT_TYPE: %', v_type;
  END IF;

  v_currency := upper(trim(COALESCE(p_currency, 'KES')));
  v_is_system := v_type IN ('settlement', 'suspense', 'fees');

  IF v_is_system THEN
    SELECT id INTO v_account_id
    FROM public.accounts
    WHERE account_type = v_type
      AND currency = v_currency
      AND external_identifier LIKE 'SYSTEM:%'
    LIMIT 1;
    IF v_account_id IS NOT NULL THEN
      RETURN v_account_id;
    END IF;
    RAISE EXCEPTION 'SYSTEM_ACCOUNT_MISSING: %', v_type;
  END IF;

  v_external := public.normalize_ledger_external_id(v_type, p_external_identifier);
  IF v_external IS NULL OR v_external = '' THEN
    RAISE EXCEPTION 'EXTERNAL_IDENTIFIER_REQUIRED for account_type %', v_type;
  END IF;

  SELECT id INTO v_account_id
  FROM public.accounts
  WHERE account_type = v_type
    AND external_identifier = v_external
    AND currency = v_currency
  LIMIT 1;

  IF v_account_id IS NOT NULL THEN
    RETURN v_account_id;
  END IF;

  INSERT INTO public.accounts (
    user_id, account_type, currency, external_identifier, display_name, status
  ) VALUES (
    p_user_id,
    v_type,
    v_currency,
    v_external,
    COALESCE(NULLIF(trim(p_display_name), ''), v_external),
    'active'
  )
  ON CONFLICT (account_type, external_identifier, currency)
    WHERE external_identifier IS NOT NULL
  DO NOTHING;

  SELECT id INTO v_account_id
  FROM public.accounts
  WHERE account_type = v_type
    AND external_identifier = v_external
    AND currency = v_currency
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_RESOLUTION_FAILED for % / %', v_type, v_external;
  END IF;

  RETURN v_account_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_or_create_account(TEXT, TEXT, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_or_create_account(TEXT, TEXT, TEXT, UUID, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_or_create_account(TEXT, TEXT, TEXT, UUID, TEXT) TO service_role;

COMMENT ON FUNCTION public.resolve_or_create_account IS
  'Idempotent account lookup/create for server-side ledger posting. service_role only.';

-- ── 5. Chain helpers ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ledger_genesis_hash()
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT '0000000000000000000000000000000000000000000000000000000000000000';
$$;

CREATE OR REPLACE FUNCTION public.compute_ledger_entry_hash(
  p_transaction_ref  TEXT,
  p_entry_type       TEXT,
  p_amount           NUMERIC,
  p_balance_before   NUMERIC,
  p_balance_after    NUMERIC,
  p_account_phone    TEXT,
  p_account_id       UUID,
  p_idempotency_key  TEXT,
  p_previous_hash    TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT encode(
    extensions.digest(
      COALESCE(p_transaction_ref, '') || '|' ||
      COALESCE(p_entry_type, '') || '|' ||
      COALESCE(p_amount::TEXT, '') || '|' ||
      COALESCE(p_balance_before::TEXT, '') || '|' ||
      COALESCE(p_balance_after::TEXT, '') || '|' ||
      COALESCE(p_account_phone, '') || '|' ||
      COALESCE(p_account_id::TEXT, '') || '|' ||
      COALESCE(p_idempotency_key, '') || '|' ||
      COALESCE(p_previous_hash, public.ledger_genesis_hash()),
      'sha256'
    ),
    'hex'
  );
$$;

CREATE OR REPLACE FUNCTION public.claim_ledger_chain_slot(
  p_chain_scope TEXT
)
RETURNS TABLE (
  chain_index   BIGINT,
  previous_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scope TEXT;
  v_index BIGINT;
  v_prev  TEXT;
BEGIN
  v_scope := COALESCE(NULLIF(trim(p_chain_scope), ''), 'global');

  INSERT INTO public.ledger_chain_heads (chain_scope)
  VALUES (v_scope)
  ON CONFLICT (chain_scope) DO NOTHING;

  SELECT h.last_chain_index, h.last_entry_hash
  INTO v_index, v_prev
  FROM public.ledger_chain_heads h
  WHERE h.chain_scope = v_scope
  FOR UPDATE;

  v_index := COALESCE(v_index, 0) + 1;

  UPDATE public.ledger_chain_heads
  SET last_chain_index = v_index,
      updated_at = now()
  WHERE chain_scope = v_scope;

  chain_index   := v_index;
  previous_hash := COALESCE(v_prev, public.ledger_genesis_hash());
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.advance_ledger_chain_head(
  p_chain_scope TEXT,
  p_entry_hash  TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ledger_chain_heads
  SET last_entry_hash = p_entry_hash,
      updated_at = now()
  WHERE chain_scope = COALESCE(NULLIF(trim(p_chain_scope), ''), 'global');
END;
$$;

REVOKE ALL ON FUNCTION public.claim_ledger_chain_slot(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.advance_ledger_chain_head(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_ledger_chain_slot(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.advance_ledger_chain_head(TEXT, TEXT) TO service_role;

-- Resolve account_id for one ledger leg inside post_double_entry.
CREATE OR REPLACE FUNCTION public.resolve_ledger_leg_account(
  p_leg       JSONB,
  p_entry_type TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_explicit UUID;
  v_type     TEXT;
  v_phone    TEXT;
  v_owner    UUID;
BEGIN
  IF p_entry_type = 'debit' THEN
    v_explicit := NULLIF(trim(COALESCE(p_leg->>'debit_account_id', p_leg->>'account_id', '')), '')::UUID;
  ELSE
    v_explicit := NULLIF(trim(COALESCE(p_leg->>'credit_account_id', p_leg->>'account_id', '')), '')::UUID;
  END IF;

  IF v_explicit IS NOT NULL THEN
    RETURN v_explicit;
  END IF;

  v_type  := COALESCE(NULLIF(trim(p_leg->>'account_type'), ''), 'wallet');
  v_phone := COALESCE(p_leg->>'account_phone', '');
  v_owner := NULLIF(trim(COALESCE(p_leg->>'owner_id', '')), '')::UUID;

  RETURN public.resolve_or_create_account(
    v_type,
    v_phone,
    COALESCE(NULLIF(trim(p_leg->>'currency'), ''), 'KES'),
    v_owner,
    COALESCE(p_leg->>'display_name', v_phone)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_ledger_leg_account(JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_ledger_leg_account(JSONB, TEXT) TO service_role;

-- ── 6. post_double_entry — accounts + hash chain (preserves idempotency) ─────

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
  v_legacy_hash       TEXT;
BEGIN

  IF (p_debit->>'transaction_ref') IS NULL OR (p_debit->>'transaction_ref') = '' THEN
    RAISE EXCEPTION 'LEDGER_INVALID: debit missing transaction_ref';
  END IF;

  IF (p_credit->>'transaction_ref') IS NULL OR (p_credit->>'transaction_ref') = '' THEN
    RAISE EXCEPTION 'LEDGER_INVALID: credit missing transaction_ref';
  END IF;

  IF (p_debit->>'transaction_ref') <> (p_credit->>'transaction_ref') THEN
    RAISE EXCEPTION 'LEDGER_PAIR: debit and credit transaction_ref must match';
  END IF;

  IF (p_debit->>'amount')::NUMERIC <> (p_credit->>'amount')::NUMERIC THEN
    RAISE EXCEPTION 'LEDGER_PAIR: debit amount % does not match credit amount %',
      p_debit->>'amount', p_credit->>'amount';
  END IF;

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

  -- ── Debit leg (skip chain claim on idempotent replay) ────────────────────
  SELECT * INTO v_debit_row
  FROM public.ledger_entries
  WHERE transaction_ref = p_debit->>'transaction_ref'
    AND entry_type = 'debit'
  LIMIT 1;

  IF v_debit_row.id IS NULL THEN
    SELECT * INTO v_slot FROM public.claim_ledger_chain_slot(v_chain_scope);
    v_prev_hash := v_slot.previous_hash;

    v_entry_hash := public.compute_ledger_entry_hash(
      p_debit->>'transaction_ref',
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
      p_debit->>'transaction_ref',
      'debit',
      (p_debit->>'amount')::NUMERIC,
      (p_debit->>'balance_before')::NUMERIC,
      (p_debit->>'balance_after')::NUMERIC,
      p_debit->>'account_phone',
      COALESCE(p_debit->>'description', ''),
      COALESCE(p_debit->>'hash', ''),
      p_debit->>'owner_id',
      p_debit->>'idempotency_key',
      v_debit_account_id,
      v_debit_account_id,
      NULL,
      v_prev_hash,
      v_entry_hash,
      v_chain_scope,
      v_slot.chain_index
    )
    ON CONFLICT (transaction_ref, entry_type)
      DO UPDATE SET transaction_ref = EXCLUDED.transaction_ref
    RETURNING * INTO v_debit_row;

    IF v_debit_row.entry_hash = v_entry_hash THEN
      PERFORM public.advance_ledger_chain_head(v_chain_scope, v_entry_hash);
    END IF;
  END IF;

  -- ── Credit leg ───────────────────────────────────────────────────────────
  SELECT * INTO v_credit_row
  FROM public.ledger_entries
  WHERE transaction_ref = p_credit->>'transaction_ref'
    AND entry_type = 'credit'
  LIMIT 1;

  IF v_credit_row.id IS NULL THEN
    v_prev_hash := COALESCE(
      v_debit_row.entry_hash,
      (SELECT h.last_entry_hash FROM public.ledger_chain_heads h WHERE h.chain_scope = v_chain_scope),
      public.ledger_genesis_hash()
    );

    SELECT * INTO v_slot FROM public.claim_ledger_chain_slot(v_chain_scope);

    v_entry_hash := public.compute_ledger_entry_hash(
      p_credit->>'transaction_ref',
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
      p_credit->>'transaction_ref',
      'credit',
      (p_credit->>'amount')::NUMERIC,
      (p_credit->>'balance_before')::NUMERIC,
      (p_credit->>'balance_after')::NUMERIC,
      p_credit->>'account_phone',
      COALESCE(p_credit->>'description', ''),
      COALESCE(p_credit->>'hash', ''),
      p_credit->>'owner_id',
      p_credit->>'idempotency_key',
      v_credit_account_id,
      NULL,
      v_credit_account_id,
      v_prev_hash,
      v_entry_hash,
      v_chain_scope,
      v_slot.chain_index
    )
    ON CONFLICT (transaction_ref, entry_type)
      DO UPDATE SET transaction_ref = EXCLUDED.transaction_ref
    RETURNING * INTO v_credit_row;

    IF v_credit_row.entry_hash = v_entry_hash THEN
      PERFORM public.advance_ledger_chain_head(v_chain_scope, v_entry_hash);
    END IF;
  END IF;

  IF v_debit_row.id IS NULL OR v_credit_row.id IS NULL THEN
    RAISE EXCEPTION 'LEDGER_CONFLICT: double-entry pair could not be written or retrieved';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'transaction_ref', p_debit->>'transaction_ref',
    'debit_id', v_debit_row.id,
    'credit_id', v_credit_row.id,
    'debit_account_id', v_debit_account_id,
    'credit_account_id', v_credit_account_id,
    'debit_chain_index', v_debit_row.chain_index,
    'credit_chain_index', v_credit_row.chain_index
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) TO service_role;

COMMENT ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) IS
  'Server-only atomic double-entry with account resolution and tamper-evident global hash chain. Idempotent ON CONFLICT replays do not advance the chain.';

-- ── 7. verify_ledger_chain (service_role only) ───────────────────────────────

CREATE OR REPLACE FUNCTION public.verify_ledger_chain(
  p_chain_scope TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scope         TEXT;
  v_row           RECORD;
  v_expected      TEXT;
  v_prev          TEXT;
  v_checked       BIGINT := 0;
  v_skipped       BIGINT := 0;
  v_genesis       TEXT;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'verify_ledger_chain is service_role only';
  END IF;

  v_scope   := COALESCE(NULLIF(trim(p_chain_scope), ''), 'global');
  v_genesis := public.ledger_genesis_hash();
  v_prev    := v_genesis;

  FOR v_row IN
    SELECT *
    FROM public.ledger_entries
    WHERE chain_scope = v_scope
      AND chain_index IS NOT NULL
      AND entry_hash IS NOT NULL
    ORDER BY chain_index ASC, created_at ASC, id ASC
  LOOP
    v_checked := v_checked + 1;

    IF v_row.chain_index <> v_checked THEN
      RETURN jsonb_build_object(
        'ok', false,
        'broken_at_entry_id', v_row.id,
        'reason', 'chain_index_gap',
        'expected_index', v_checked,
        'actual_index', v_row.chain_index,
        'checked_count', v_checked - 1,
        'skipped_legacy_count', v_skipped
      );
    END IF;

    IF COALESCE(v_row.previous_hash, v_genesis) <> v_prev THEN
      RETURN jsonb_build_object(
        'ok', false,
        'broken_at_entry_id', v_row.id,
        'reason', 'previous_hash_mismatch',
        'expected_hash', v_prev,
        'actual_hash', v_row.previous_hash,
        'checked_count', v_checked - 1,
        'skipped_legacy_count', v_skipped
      );
    END IF;

    v_expected := public.compute_ledger_entry_hash(
      v_row.transaction_ref,
      v_row.entry_type,
      v_row.amount,
      v_row.balance_before,
      v_row.balance_after,
      v_row.account_phone,
      v_row.account_id,
      v_row.idempotency_key,
      COALESCE(v_row.previous_hash, v_genesis)
    );

    IF v_row.entry_hash <> v_expected THEN
      RETURN jsonb_build_object(
        'ok', false,
        'broken_at_entry_id', v_row.id,
        'reason', 'entry_hash_mismatch',
        'expected_hash', v_expected,
        'actual_hash', v_row.entry_hash,
        'checked_count', v_checked - 1,
        'skipped_legacy_count', v_skipped
      );
    END IF;

    v_prev := v_row.entry_hash;
  END LOOP;

  SELECT COUNT(*) INTO v_skipped
  FROM public.ledger_entries
  WHERE (p_chain_scope IS NULL OR chain_scope = v_scope)
    AND (chain_index IS NULL OR entry_hash IS NULL);

  RETURN jsonb_build_object(
    'ok', true,
    'broken_at_entry_id', NULL,
    'expected_hash', NULL,
    'actual_hash', NULL,
    'checked_count', v_checked,
    'skipped_legacy_count', v_skipped,
    'chain_scope', v_scope
  );
END;
$$;

REVOKE ALL ON FUNCTION public.verify_ledger_chain(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_ledger_chain(TEXT) TO service_role;

COMMENT ON FUNCTION public.verify_ledger_chain IS
  'Ops/admin tamper check for hash-chained ledger rows. service_role only; skips legacy rows without chain_index.';

-- ── 8. Append-only trigger — allow no-op idempotency on new columns ──────────

CREATE OR REPLACE FUNCTION public.prevent_ledger_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only; DELETE is not permitted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.transaction_ref, NEW.entry_type, NEW.amount,
      NEW.balance_before, NEW.balance_after, NEW.account_phone,
      NEW.description, NEW.hash, NEW.owner_id, NEW.created_at,
      NEW.idempotency_key, NEW.account_id, NEW.debit_account_id,
      NEW.credit_account_id, NEW.previous_hash, NEW.entry_hash,
      NEW.chain_scope, NEW.chain_index
    ) IS DISTINCT FROM ROW(
      OLD.transaction_ref, OLD.entry_type, OLD.amount,
      OLD.balance_before, OLD.balance_after, OLD.account_phone,
      OLD.description, OLD.hash, OLD.owner_id, OLD.created_at,
      OLD.idempotency_key, OLD.account_id, OLD.debit_account_id,
      OLD.credit_account_id, OLD.previous_hash, OLD.entry_hash,
      OLD.chain_scope, OLD.chain_index
    ) THEN
      RAISE EXCEPTION 'ledger_entries is append-only; UPDATE is not permitted';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- ── 9. RLS — accounts ────────────────────────────────────────────────────────

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts FORCE ROW LEVEL SECURITY;

DO $$
DECLARE p record;
BEGIN
  FOR p IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'accounts'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.accounts', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "accounts_select_own_non_system"
  ON public.accounts
  FOR SELECT
  TO authenticated
  USING (
    user_id = auth.uid()
    AND account_type NOT IN ('settlement', 'suspense', 'fees')
    AND status = 'active'
  );

CREATE POLICY "accounts_service_role_all"
  ON public.accounts
  FOR ALL
  TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE INSERT, UPDATE, DELETE ON public.accounts FROM anon, authenticated;
GRANT SELECT ON public.accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.accounts TO service_role;

ALTER TABLE public.ledger_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ledger_chain_heads FORCE ROW LEVEL SECURITY;

CREATE POLICY "ledger_chain_heads_service_role_only"
  ON public.ledger_chain_heads
  FOR ALL
  TO service_role
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

REVOKE ALL ON public.ledger_chain_heads FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_chain_heads TO service_role;

COMMENT ON TABLE public.ledger_chain_heads IS
  'Mutable chain head pointers — service_role only. Ledger rows remain append-only.';
