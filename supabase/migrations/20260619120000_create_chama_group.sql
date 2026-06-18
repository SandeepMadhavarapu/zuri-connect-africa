-- =============================================================================
-- create_chama_group — atomic chama group creation RPC
--
-- Prompt 3.4. Called by the create-chama-group Edge Function (service_role)
-- after it has verified the caller's JWT and validated input. In ONE function
-- body (one implicit transaction):
--   1. Inserts the chama_groups row (created_by = the authenticated user).
--   2. Inserts the chama_members row for that same user as role 'chair',
--      status 'active'.
--   3. Returns the new group row as JSONB.
--
-- A group with no members is invalid state, so both rows are created together
-- or neither — the implicit transaction around the function body guarantees it.
--
-- SECURITY DEFINER — runs as definer (postgres) so the writes are immune to the
-- FORCE ROW LEVEL SECURITY on chama_groups / chama_members regardless of caller.
--
-- IDENTITY: the caller's user id is PASSED IN as p_user_id, not derived via
-- auth.uid(). The Edge Function talks to Postgres through the service_role
-- client (no end-user JWT in the DB session), so auth.uid() would be NULL here.
-- The Edge Function is the sole identity authority: it derives the id from
-- getUser(jwt) on the verified token and passes it as p_user_id.
--
-- GRANT: service_role only — REVOKE from PUBLIC, anon, authenticated. This is
-- the same trust boundary as settle_chama_contribution. Granting to
-- authenticated would let any logged-in user call this RPC directly via
-- PostgREST, bypassing the Edge Function's validation and rate limiting.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_chama_group(
  p_user_id     UUID,
  p_name        TEXT,
  p_description TEXT,
  p_currency    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  gr public.chama_groups%ROWTYPE;
BEGIN
  -- Defensive: the Edge Function always supplies a verified user id. Never
  -- create a group with a NULL owner.
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'USER_ID_REQUIRED';
  END IF;

  -- ── Step 1: Insert the group ──────────────────────────────────────────────
  -- created_by = the authenticated user. The DB CHECK on name (3..80 chars) and
  -- status default ('active') still apply as a backstop to the Edge Function's
  -- validation. currency falls back to the column default when NULL is passed.
  INSERT INTO public.chama_groups (name, description, currency, created_by)
  VALUES (
    p_name,
    p_description,
    COALESCE(NULLIF(p_currency, ''), 'KES'),
    p_user_id
  )
  RETURNING * INTO gr;

  -- ── Step 2: Insert the creator as the first member ────────────────────────
  -- Same user, role 'chair', status 'active'. joined_at stamped now so the
  -- member is immediately active. Runs in the same transaction as Step 1: if
  -- this fails the group insert rolls back too.
  INSERT INTO public.chama_members (group_id, user_id, role, status, joined_at)
  VALUES (gr.id, p_user_id, 'chair', 'active', now());

  -- ── Step 3: Return the new group row ──────────────────────────────────────
  RETURN jsonb_build_object(
    'id',          gr.id,
    'name',        gr.name,
    'description', gr.description,
    'currency',    gr.currency,
    'status',      gr.status,
    'created_by',  gr.created_by,
    'created_at',  gr.created_at
  );
END;
$$;

-- ── Permissions ──────────────────────────────────────────────────────────────
-- create-chama-group Edge Function calls this via supabaseAdmin (service_role)
-- AFTER verifying the JWT, validating input, and rate-limiting. All other roles
-- must never reach this function directly.

REVOKE ALL ON FUNCTION public.create_chama_group(UUID, TEXT, TEXT, TEXT)
  FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_chama_group(UUID, TEXT, TEXT, TEXT)
  FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.create_chama_group(UUID, TEXT, TEXT, TEXT)
  TO service_role;

COMMENT ON FUNCTION public.create_chama_group(UUID, TEXT, TEXT, TEXT) IS
  'Atomic chama group creation: inserts chama_groups (created_by = p_user_id) '
  'and chama_members (p_user_id, role chair, status active) in one transaction. '
  'Returns the new group as JSONB. Identity is passed in as p_user_id by the '
  'create-chama-group Edge Function (not derived from session). service_role only.';
