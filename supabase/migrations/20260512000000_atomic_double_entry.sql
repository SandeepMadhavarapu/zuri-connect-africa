-- =====================================================
-- Atomic Double-Entry Ledger Posting
-- =====================================================
-- Ensures debit + credit entries are inserted atomically.
-- If either insert fails, the entire transaction rolls back.
-- Called via supabase.rpc('post_double_entry')
--
-- IMPORTANT: Do NOT add explicit BEGIN/COMMIT.
-- PL/pgSQL functions are already transactional.
-- =====================================================

-- Ensure required uniqueness constraint exists for idempotent writes
ALTER TABLE public.ledger_entries
  DROP CONSTRAINT IF EXISTS ledger_entries_tx_ref_entry_type_unique;

ALTER TABLE public.ledger_entries
  ADD CONSTRAINT ledger_entries_tx_ref_entry_type_unique
  UNIQUE (transaction_ref, entry_type);

CREATE OR REPLACE FUNCTION public.post_double_entry(
  p_debit  JSONB,
  p_credit JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_debit_row  ledger_entries%ROWTYPE;
  v_credit_row ledger_entries%ROWTYPE;
BEGIN

  -- ===================================================
  -- VALIDATION
  -- ===================================================

  IF (p_debit->>'transaction_ref') IS NULL
  OR (p_debit->>'transaction_ref') = '' THEN
    RAISE EXCEPTION 'LEDGER_INVALID: debit missing transaction_ref';
  END IF;

  IF (p_credit->>'transaction_ref') IS NULL
  OR (p_credit->>'transaction_ref') = '' THEN
    RAISE EXCEPTION 'LEDGER_INVALID: credit missing transaction_ref';
  END IF;

  IF (p_debit->>'transaction_ref')
  <> (p_credit->>'transaction_ref') THEN
    RAISE EXCEPTION
      'LEDGER_PAIR: debit and credit transaction_ref must match';
  END IF;

  IF (p_debit->>'amount')::NUMERIC
  <> (p_credit->>'amount')::NUMERIC THEN
    RAISE EXCEPTION
      'LEDGER_PAIR: debit amount % does not match credit amount %',
      p_debit->>'amount',
      p_credit->>'amount';
  END IF;

  -- ===================================================
  -- DEBIT INSERT
  -- No-op update forces RETURNING * to populate on conflict
  -- ===================================================

  INSERT INTO public.ledger_entries (
    transaction_ref,
    entry_type,
    amount,
    balance_before,
    balance_after,
    account_phone,
    description,
    hash,
    owner_id,
    idempotency_key
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
    p_debit->>'idempotency_key'
  )
  ON CONFLICT (transaction_ref, entry_type)
    DO UPDATE SET transaction_ref = EXCLUDED.transaction_ref
  RETURNING * INTO v_debit_row;

  -- ===================================================
  -- CREDIT INSERT
  -- No-op update forces RETURNING * to populate on conflict
  -- ===================================================

  INSERT INTO public.ledger_entries (
    transaction_ref,
    entry_type,
    amount,
    balance_before,
    balance_after,
    account_phone,
    description,
    hash,
    owner_id,
    idempotency_key
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
    p_credit->>'idempotency_key'
  )
  ON CONFLICT (transaction_ref, entry_type)
    DO UPDATE SET transaction_ref = EXCLUDED.transaction_ref
  RETURNING * INTO v_credit_row;

  -- ===================================================
  -- SAFETY CHECKS
  -- ===================================================

  IF v_debit_row.id IS NULL THEN
    RAISE EXCEPTION 'LEDGER_DEBIT_CONFLICT: debit entry could not be written or retrieved';
  END IF;

  IF v_credit_row.id IS NULL THEN
    RAISE EXCEPTION 'LEDGER_CREDIT_CONFLICT: credit entry could not be written or retrieved';
  END IF;

  -- ===================================================
  -- RETURN
  -- ===================================================

  RETURN jsonb_build_object(
    'ok',              true,
    'transaction_ref', p_debit->>'transaction_ref',
    'debit_id',        v_debit_row.id,
    'credit_id',       v_credit_row.id
  );

END;
$$;

GRANT EXECUTE
  ON FUNCTION public.post_double_entry(JSONB, JSONB)
  TO authenticated;

GRANT EXECUTE
  ON FUNCTION public.post_double_entry(JSONB, JSONB)
  TO service_role;

COMMENT ON FUNCTION public.post_double_entry(JSONB, JSONB) IS
  'Atomic double-entry ledger write. Both debit and credit are inserted in one transaction. Either both succeed or both roll back. ON CONFLICT forces idempotent behaviour.';
