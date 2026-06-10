-- ============================================================
-- CHAMA CORE SCHEMA
-- Group savings treasury layer on top of the payments engine.
-- All writes go through Edge Functions (service_role).
-- Users get SELECT-only access scoped to groups they belong to.
-- ============================================================

BEGIN;

-- ============================================================
-- 1. chama_groups
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chama_groups (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 3 AND 80),
  description TEXT,
  currency    TEXT        NOT NULL DEFAULT 'KES',
  status      TEXT        NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'frozen', 'closed')),
  created_by  UUID        NOT NULL REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. chama_members
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chama_members (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID        NOT NULL REFERENCES public.chama_groups(id),
  user_id    UUID        NOT NULL REFERENCES auth.users(id),
  role       TEXT        NOT NULL DEFAULT 'member'
                           CHECK (role IN ('member', 'treasurer', 'chair', 'secretary')),
  status     TEXT        NOT NULL DEFAULT 'invited'
                           CHECK (status IN ('invited', 'active', 'suspended', 'exited')),
  joined_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);

-- ============================================================
-- 3. chama_contribution_cycles
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chama_contribution_cycles (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID        NOT NULL REFERENCES public.chama_groups(id),
  name         TEXT        NOT NULL,
  amount_cents BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency     TEXT        NOT NULL DEFAULT 'KES',
  due_at       TIMESTAMPTZ NOT NULL,
  grace_days   INT         NOT NULL DEFAULT 3 CHECK (grace_days >= 0),
  status       TEXT        NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft', 'open', 'closed')),
  created_by   UUID        NOT NULL REFERENCES auth.users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, name)
);

-- ============================================================
-- 4. chama_obligations
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chama_obligations (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id         UUID        NOT NULL REFERENCES public.chama_contribution_cycles(id),
  group_id         UUID        NOT NULL REFERENCES public.chama_groups(id),
  member_id        UUID        NOT NULL REFERENCES public.chama_members(id),
  amount_due_cents BIGINT      NOT NULL CHECK (amount_due_cents > 0),
  status           TEXT        NOT NULL DEFAULT 'due'
                                 CHECK (status IN ('due', 'pending_payment', 'settled', 'waived')),
  -- Soft reference to pending_payments.tx_ref by VALUE only.
  -- No FK constraint: keeps the payments engine fully decoupled.
  payment_tx_ref   TEXT,
  settled_receipt  TEXT,
  settled_at       TIMESTAMPTZ,
  ledger_tx_ref    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cycle_id, member_id)
);

-- Partial unique index: duplicate-callback defense at the chama layer.
-- A settled_receipt can appear at most once across all obligations.
CREATE UNIQUE INDEX IF NOT EXISTS chama_obligations_settled_receipt_uq
  ON public.chama_obligations (settled_receipt)
  WHERE settled_receipt IS NOT NULL;

-- One payment attempt maps to at most one obligation (lookup + duplicate guard).
CREATE UNIQUE INDEX IF NOT EXISTS chama_obligations_payment_tx_ref_uq
  ON public.chama_obligations (payment_tx_ref)
  WHERE payment_tx_ref IS NOT NULL;

-- ============================================================
-- 5. chama_payouts
-- ============================================================

CREATE TABLE IF NOT EXISTS public.chama_payouts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id           UUID        NOT NULL REFERENCES public.chama_groups(id),
  amount_cents       BIGINT      NOT NULL CHECK (amount_cents > 0),
  currency           TEXT        NOT NULL DEFAULT 'KES',
  purpose            TEXT        NOT NULL,
  destination_kind   TEXT        NOT NULL
                                   CHECK (destination_kind IN ('member_phone', 'verified_provider', 'manual_record')),
  destination_ref    TEXT        NOT NULL,
  requested_by       UUID        NOT NULL REFERENCES public.chama_members(id),
  approved_by        UUID                 REFERENCES public.chama_members(id),
  status             TEXT        NOT NULL DEFAULT 'requested'
                                   CHECK (status IN ('requested', 'approved', 'executing', 'completed', 'failed', 'cancelled')),
  step_up_session_id UUID,
  executed_receipt   TEXT,
  ledger_tx_ref      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Treasurer/chair cannot approve their own payout request.
  CHECK (approved_by IS NULL OR approved_by <> requested_by)
);

-- ============================================================
-- Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_chama_members_user_id
  ON public.chama_members (user_id);

CREATE INDEX IF NOT EXISTS idx_chama_members_group_status
  ON public.chama_members (group_id, status);

CREATE INDEX IF NOT EXISTS idx_chama_obligations_group_status
  ON public.chama_obligations (group_id, status);

CREATE INDEX IF NOT EXISTS idx_chama_payouts_group_id
  ON public.chama_payouts (group_id);

-- ============================================================
-- SECURITY DEFINER helper: avoids RLS recursion on chama_members.
-- Policies on chama_members must not query chama_members directly
-- (infinite recursion). This SECURITY DEFINER function runs as the
-- definer (bypassing RLS on chama_members) so it is safe to call
-- from within any chama table policy.
-- ============================================================

CREATE OR REPLACE FUNCTION public.chama_is_active_member(p_group_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   public.chama_members
    WHERE  group_id = p_group_id
      AND  user_id  = auth.uid()
      AND  status   = 'active'
  );
$$;

COMMENT ON FUNCTION public.chama_is_active_member(UUID) IS
  'SECURITY DEFINER membership check used in chama RLS policies to prevent self-referential recursion on chama_members.';

-- ============================================================
-- RLS — enable + force on all five tables.
-- No INSERT/UPDATE/DELETE policies: all writes go through Edge
-- Functions running as service_role, which has BYPASSRLS.
-- ============================================================

ALTER TABLE public.chama_groups              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chama_groups              FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.chama_members             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chama_members             FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.chama_contribution_cycles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chama_contribution_cycles FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.chama_obligations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chama_obligations         FORCE  ROW LEVEL SECURITY;

ALTER TABLE public.chama_payouts             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chama_payouts             FORCE  ROW LEVEL SECURITY;

-- ============================================================
-- SELECT policies: active group members only.
-- service_role check is belt-and-suspenders (it has BYPASSRLS),
-- mirroring the rls_lockdown style in the rest of the schema.
-- ============================================================

-- chama_groups: visible to active members of that group
CREATE POLICY "chama_groups_select_member"
  ON public.chama_groups FOR SELECT
  USING (
    public.chama_is_active_member(id)
    OR auth.role() = 'service_role'
  );

-- chama_members: visible to active members of the same group
-- (uses SECURITY DEFINER helper to avoid self-referential recursion)
CREATE POLICY "chama_members_select_member"
  ON public.chama_members FOR SELECT
  USING (
    public.chama_is_active_member(group_id)
    OR auth.role() = 'service_role'
  );

-- chama_contribution_cycles: visible to active members of that group
CREATE POLICY "chama_cycles_select_member"
  ON public.chama_contribution_cycles FOR SELECT
  USING (
    public.chama_is_active_member(group_id)
    OR auth.role() = 'service_role'
  );

-- chama_obligations: visible to active members of the obligation's group
CREATE POLICY "chama_obligations_select_member"
  ON public.chama_obligations FOR SELECT
  USING (
    public.chama_is_active_member(group_id)
    OR auth.role() = 'service_role'
  );

-- chama_payouts: visible to active members of that group
CREATE POLICY "chama_payouts_select_member"
  ON public.chama_payouts FOR SELECT
  USING (
    public.chama_is_active_member(group_id)
    OR auth.role() = 'service_role'
  );

COMMIT;
