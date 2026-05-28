-- =====================================================
-- Optimistic Balance Lock for post_double_entry
-- =====================================================
-- Replaces the post_double_entry function with a new
-- version that accepts an optional expected balance.
-- Before inserting the debit, verifies the account's
-- current balance matches what the client read.
-- If another transaction modified the balance first,
-- raises LEDGER_RACE so the client retries safely.
--
-- The third parameter is optional (DEFAULT NULL) so
-- existing callers without the balance check still work.
-- =====================================================

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
  v_debit_row       ledger_entries%ROWTYPE;
  v_credit_row      ledger_entries%ROWTYPE;
  v_current_balance NUMERIC;
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
  -- OPTIMISTIC BALANCE LOCK
  -- Only runs when caller passes p_expect_debit_balance_before.
  -- Reads the most recent balance_after for this account.
  -- If it differs from what the client expected, another
  -- transaction got there first — raise LEDGER_RACE.
  -- ===================================================

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
        p_expect_debit_balance_before,
        v_current_balance;
    END IF;

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
    RAISE EXCEPTION
      'LEDGER_DEBIT_CONFLICT: debit entry could not be written or retrieved';
  END IF;

  IF v_credit_row.id IS NULL THEN
    RAISE EXCEPTION
      'LEDGER_CREDIT_CONFLICT: credit entry could not be written or retrieved';
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
  ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC)
  TO authenticated;

GRANT EXECUTE
  ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC)
  TO service_role;

COMMENT ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) IS
  'Atomic double-entry ledger write with optimistic balance lock. '
  'Raises LEDGER_RACE if balance changed since client read. '
  'Either both entries succeed or both roll back.';
