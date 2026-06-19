-- =============================================================================
-- create_contribution_cycle — atomic "open a contribution cycle" RPC
--
-- Prompt 3.6a. Called by the create-contribution-cycle Edge Function
-- (service_role) after it has verified the caller's JWT, confirmed the caller
-- is an active chair/treasurer of the group, and validated input. In ONE
-- function body (one implicit transaction):
--   1. Loads + validates the group (must exist and be 'active').
--   2. Enforces the ONE-OPEN-CYCLE-PER-GROUP invariant (see below).
--   3. Inserts the chama_contribution_cycles row with status 'open'.
--   4. Generates one chama_obligations row per ACTIVE member via a single
--      INSERT ... SELECT, in the same transaction.
--   5. Returns the new cycle row + obligation_count as JSONB.
--
-- A cycle with no obligations is meaningless state, so the cycle insert and the
-- obligation generation are all-or-nothing inside this one function body — the
-- implicit transaction around the body guarantees it. If obligation generation
-- fails (or produces zero rows), the cycle insert rolls back too.
--
-- ONE OPEN CYCLE MAX (the critical invariant): there is NO DB constraint that
-- can express "at most one row with status='open' per group_id". The Edge
-- Function is not the only possible caller of a service_role RPC, so the rule is
-- enforced HERE, inside the transaction, via an EXISTS guard. Even a direct
-- service_role call cannot create a second concurrent open cycle.
--
-- SECURITY DEFINER — runs as definer (postgres) so the writes are immune to the
-- FORCE ROW LEVEL SECURITY on chama_contribution_cycles / chama_obligations
-- regardless of caller.
--
-- IDENTITY: the caller's user id is PASSED IN as p_user_id, not derived via
-- auth.uid(). The Edge Function talks to Postgres through the service_role
-- client (no end-user JWT in the DB session), so auth.uid() would be NULL here.
-- The Edge Function is the sole identity authority: it derives the id from
-- getUser(jwt) on the verified token, checks chair/treasurer authorization, and
-- passes the id as p_user_id (= created_by). Identical model to create_chama_group.
--
-- GRANT: service_role only — REVOKE from PUBLIC, anon, authenticated. Same trust
-- boundary as create_chama_group / settle_chama_contribution. Granting to
-- authenticated would let any logged-in user call this RPC directly via
-- PostgREST, bypassing the Edge Function's authorization, validation, and rate
-- limiting.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_contribution_cycle(
  p_user_id     UUID,
  p_group_id    UUID,
  p_name        TEXT,
  p_amount_cents BIGINT,
  p_due_at      TIMESTAMPTZ,
  p_grace_days  INT DEFAULT 3
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cy            public.chama_contribution_cycles%ROWTYPE;
  v_group       public.chama_groups%ROWTYPE;
  v_oblig_count INT;
BEGIN
  -- ── Guard 1: NULL user id ─────────────────────────────────────────────────
  -- Defensive: the Edge Function always supplies a verified user id. Never
  -- create a cycle with a NULL creator.
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_ID_REQUIRED';
  END IF;

  -- ── Guard 2: NULL group id ────────────────────────────────────────────────
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'GROUP_ID_REQUIRED';
  END IF;

  -- ── Guard 3: group must exist and be active ───────────────────────────────
  SELECT * INTO v_group
  FROM public.chama_groups
  WHERE id = p_group_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'GROUP_NOT_FOUND';
  END IF;

  IF v_group.status <> 'active' THEN
    RAISE EXCEPTION 'GROUP_NOT_ACTIVE';
  END IF;

  -- ── Guard 4: ONE OPEN CYCLE MAX ───────────────────────────────────────────
  -- Enforced in-RPC (not just the Edge Function) so even a direct service_role
  -- call cannot create a second open cycle. No DB constraint can express this.
  IF EXISTS (
    SELECT 1
    FROM public.chama_contribution_cycles
    WHERE group_id = p_group_id
      AND status   = 'open'
  ) THEN
    RAISE EXCEPTION 'OPEN_CYCLE_EXISTS';
  END IF;

  -- ── Guard 5: amount must be positive ──────────────────────────────────────
  -- The DB CHECK (amount_cents > 0) is the backstop; check here for a clean
  -- mappable error instead of a raw CHECK violation.
  IF p_amount_cents IS NULL OR p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'AMOUNT_INVALID';
  END IF;

  -- ── Insert the cycle (status 'open' — opened immediately, not draft) ──────
  -- The inner BEGIN..EXCEPTION block exists ONLY to map a UNIQUE(group_id, name)
  -- collision to the clean string CYCLE_NAME_EXISTS so the Edge Function returns
  -- a 409 instead of a raw DB error. It does NOT catch WHEN OTHERS, so every
  -- other error still propagates and rolls back the whole transaction (no orphan
  -- cycle). currency falls back to the group's currency, then 'KES'.
  BEGIN
    INSERT INTO public.chama_contribution_cycles
      (group_id, name, amount_cents, currency, due_at, grace_days, status, created_by)
    VALUES (
      p_group_id,
      p_name,
      p_amount_cents,
      COALESCE(NULLIF(v_group.currency, ''), 'KES'),
      p_due_at,
      COALESCE(p_grace_days, 3),
      'open',
      p_user_id
    )
    RETURNING * INTO cy;
  EXCEPTION
    WHEN unique_violation THEN
      RAISE EXCEPTION 'CYCLE_NAME_EXISTS';
  END;

  -- ── Generate one obligation per ACTIVE member (atomic, same transaction) ──
  -- Runs in the same function body as the cycle insert: if this fails the cycle
  -- insert rolls back too — no orphan cycle without obligations. The
  -- UNIQUE(cycle_id, member_id) constraint makes duplicate obligations impossible.
  INSERT INTO public.chama_obligations
    (cycle_id, group_id, member_id, amount_due_cents, status)
  SELECT cy.id, p_group_id, m.id, p_amount_cents, 'due'
  FROM public.chama_members m
  WHERE m.group_id = p_group_id
    AND m.status   = 'active';

  GET DIAGNOSTICS v_oblig_count = ROW_COUNT;

  -- ── Guard: zero active members ────────────────────────────────────────────
  -- A cycle nobody owes is meaningless; roll the whole transaction back (cycle
  -- insert included). A healthy chama always has at least its chair active, so
  -- this mainly guards against corrupt state.
  IF v_oblig_count = 0 THEN
    RAISE EXCEPTION 'NO_ACTIVE_MEMBERS';
  END IF;

  -- ── Return the new cycle row + obligation count ───────────────────────────
  RETURN jsonb_build_object(
    'id',               cy.id,
    'group_id',         cy.group_id,
    'name',             cy.name,
    'amount_cents',     cy.amount_cents,
    'currency',         cy.currency,
    'due_at',           cy.due_at,
    'grace_days',       cy.grace_days,
    'status',           cy.status,
    'created_by',       cy.created_by,
    'created_at',       cy.created_at,
    'obligation_count', v_oblig_count
  );
END;
$$;

-- ── Permissions ──────────────────────────────────────────────────────────────
-- create-contribution-cycle Edge Function calls this via supabaseAdmin
-- (service_role) AFTER verifying the JWT, confirming chair/treasurer
-- authorization, validating input, and rate-limiting. All other roles must
-- never reach this function directly.

REVOKE ALL ON FUNCTION public.create_contribution_cycle(UUID, UUID, TEXT, BIGINT, TIMESTAMPTZ, INT)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_contribution_cycle(UUID, UUID, TEXT, BIGINT, TIMESTAMPTZ, INT)
  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_contribution_cycle(UUID, UUID, TEXT, BIGINT, TIMESTAMPTZ, INT)
  TO service_role;

COMMENT ON FUNCTION public.create_contribution_cycle(UUID, UUID, TEXT, BIGINT, TIMESTAMPTZ, INT) IS
  'Atomic contribution cycle creation: inserts chama_contribution_cycles (status '
  'open, created_by = p_user_id) and generates one chama_obligations row per '
  'active member via INSERT...SELECT, in one transaction. Enforces the '
  'one-open-cycle-per-group invariant IN-RPC (OPEN_CYCLE_EXISTS) so even a direct '
  'service_role call cannot create a second open cycle. Returns the new cycle + '
  'obligation_count as JSONB. Identity is passed in as p_user_id by the '
  'create-contribution-cycle Edge Function (not derived from session). service_role only.';
