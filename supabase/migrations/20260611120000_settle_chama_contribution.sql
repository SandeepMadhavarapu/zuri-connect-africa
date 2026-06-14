-- =============================================================================
-- settle_chama_contribution — atomic chama payment settlement RPC
--
-- Prompt 3.3a (Part B). Called by the webhook-handler after Daraja confirms a
-- chama_contribution payment. In ONE transaction:
--   1. Locks both pending_payments and chama_obligations rows (FOR UPDATE).
--   2. Guards idempotency and amount correctness.
--   3. Posts the ledger debit/credit pair via post_double_entry.
--   4. Marks pending_payments succeeded and chama_obligations settled.
--
-- SECURITY DEFINER — runs as definer (postgres) so it can write ledger rows
-- and account records via the service_role-only ledger primitives.
-- Callable by service_role only; all other roles are REVOKEd.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.settle_chama_contribution(
  p_tx_ref       TEXT,
  p_receipt      TEXT,
  p_settled_at   TIMESTAMPTZ,
  p_payload_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  pp                 public.pending_payments%ROWTYPE;
  ob                 public.chama_obligations%ROWTYPE;
  gr                 public.chama_groups%ROWTYPE;
  debit_bal_before   NUMERIC;
  credit_bal_before  NUMERIC;
  p_debit            JSONB;
  p_credit           JSONB;
BEGIN

  -- ── Step 1: Lock pending_payments row ─────────────────────────────────────
  SELECT * INTO pp
  FROM public.pending_payments
  WHERE tx_ref = p_tx_ref
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'PENDING_NOT_FOUND');
  END IF;

  -- ── Step 2: Lock chama_obligations row ────────────────────────────────────
  -- Zero rows means this is a non-chama tx_ref. Return gracefully without
  -- touching the pending row — the webhook handler handles non-chama paths
  -- via finalizeDarajaPayment (design §4-D).
  SELECT * INTO ob
  FROM public.chama_obligations
  WHERE payment_tx_ref = p_tx_ref
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok',                true,
      'obligation_settled', false,
      'reason',            'no_obligation'
    );
  END IF;

  -- ── Step 3: Idempotency — same receipt already settled ────────────────────
  IF ob.status = 'settled' AND ob.settled_receipt = p_receipt THEN
    RETURN jsonb_build_object(
      'ok',           true,
      'duplicate',    true,
      'obligation_id', ob.id
    );
  END IF;

  -- ── Step 4: Amount verification ───────────────────────────────────────────
  -- Returns rather than RAISEs so the webhook handler can record
  -- review_required without the transaction aborting.
  IF round(pp.amount * 100) <> ob.amount_due_cents THEN
    RETURN jsonb_build_object(
      'ok',               false,
      'error',            'AMOUNT_MISMATCH',
      'pending_cents',    round(pp.amount * 100),
      'obligation_cents', ob.amount_due_cents
    );
  END IF;

  -- ── Step 5: Read balance_before for both ledger legs ─────────────────────
  SELECT COALESCE(
    (
      SELECT balance_after
      FROM public.ledger_entries
      WHERE account_phone = pp.from_phone
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ),
    0
  ) INTO debit_bal_before;

  SELECT COALESCE(
    (
      SELECT balance_after
      FROM public.ledger_entries
      WHERE account_phone = 'CHAMA:' || ob.group_id::TEXT
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    ),
    0
  ) INTO credit_bal_before;

  -- Fetch group for display_name on the treasury account.
  SELECT * INTO gr FROM public.chama_groups WHERE id = ob.group_id;

  -- ── Steps 6-8: Atomic sub-block — all three writes succeed or all roll back
  BEGIN

    -- Step 6: Build leg JSONBs and post the double-entry pair.
    -- p_expect_debit_balance_before = NULL: skip pre-check because M-PESA
    -- has already confirmed the money left the member's handset.
    p_debit := jsonb_build_object(
      'transaction_ref',  p_tx_ref,
      'amount',           pp.amount::TEXT,
      'balance_before',   debit_bal_before::TEXT,
      'balance_after',    (debit_bal_before - pp.amount)::TEXT,
      'account_phone',    pp.from_phone,
      'account_type',     'wallet',
      'owner_id',         pp.user_id::TEXT,
      'description',      'Chama contribution ' || ob.group_id::TEXT,
      'idempotency_key',  pp.idempotency_key,
      'hash',             ''
    );

    p_credit := jsonb_build_object(
      'transaction_ref',  p_tx_ref,
      'amount',           pp.amount::TEXT,
      'balance_before',   credit_bal_before::TEXT,
      'balance_after',    (credit_bal_before + pp.amount)::TEXT,
      'account_phone',    'CHAMA:' || ob.group_id::TEXT,
      'account_type',     'savings',
      'display_name',     COALESCE(gr.name, 'CHAMA:' || ob.group_id::TEXT),
      'owner_id',         NULL,
      'description',      'Chama contribution ' || ob.group_id::TEXT,
      'idempotency_key',  pp.idempotency_key,
      'hash',             ''
    );

    PERFORM public.post_double_entry(p_debit, p_credit, NULL);

    -- Step 7: Mark pending payment as succeeded.
    UPDATE public.pending_payments
    SET
      status                = 'succeeded',
      ledger_posted_at      = now(),
      provider_receipt      = p_receipt,
      callback_payload_hash = p_payload_hash
    WHERE tx_ref = p_tx_ref;

    -- Step 8: Settle the obligation.
    -- chama_obligations_settled_receipt_uq is the concurrent-race backstop:
    -- if another call already wrote this receipt the UPDATE hits zero rows
    -- (settled_receipt already set) which is caught by the duplicate check
    -- above on re-entry. A direct unique violation here is also caught below.
    UPDATE public.chama_obligations
    SET
      status          = 'settled',
      settled_receipt = p_receipt,
      settled_at      = p_settled_at,
      ledger_tx_ref   = p_tx_ref
    WHERE id = ob.id;

  EXCEPTION
    -- A concurrent call already settled this receipt; the unique index
    -- chama_obligations_settled_receipt_uq raised unique_violation before we
    -- could write settled_receipt. post_double_entry is idempotent so the
    -- ledger is correct; treat this as a successful duplicate, not a failure.
    WHEN unique_violation THEN
      RETURN jsonb_build_object('ok', true, 'duplicate', true, 'obligation_id', ob.id);
    -- Any other failure in steps 6-8 rolls back the entire sub-block (ledger
    -- entries, pending_payment update, obligation update). Outer transaction
    -- commits cleanly with only the SELECT FOR UPDATE locks, which release.
    WHEN OTHERS THEN
      RETURN jsonb_build_object(
        'ok',     false,
        'error',  'LEDGER_POST_FAILED',
        'detail', SQLERRM
      );
  END;

  -- ── Step 9: Return success ─────────────────────────────────────────────────
  RETURN jsonb_build_object(
    'ok',                true,
    'duplicate',         false,
    'obligation_id',     ob.id,
    'ledger_tx_ref',     p_tx_ref,
    'obligation_settled', true
  );
END;
$$;

-- ── Permissions ───────────────────────────────────────────────────────────────
-- Webhook-handler calls this via supabaseAdmin (service_role). All other roles
-- must never reach this function.

REVOKE ALL ON FUNCTION public.settle_chama_contribution(TEXT, TEXT, TIMESTAMPTZ, TEXT)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.settle_chama_contribution(TEXT, TEXT, TIMESTAMPTZ, TEXT)
  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.settle_chama_contribution(TEXT, TEXT, TIMESTAMPTZ, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.settle_chama_contribution(TEXT, TEXT, TIMESTAMPTZ, TEXT) IS
  'Atomic chama contribution settlement: locks pending_payments + chama_obligations, '
  'verifies amount, posts ledger debit/credit pair, marks both rows settled — all in '
  'one transaction. Returns JSONB {ok, duplicate?, obligation_id?, ledger_tx_ref?, '
  'obligation_settled?}. service_role only.';
