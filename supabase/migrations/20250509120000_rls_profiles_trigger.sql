-- Tighten RLS, add profile + wallet bootstrap on signup, one wallet per user.

-- ── One wallet per user (data integrity) ─────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS wallets_one_per_user ON public.wallets (user_id);

-- ── JWT helpers (stable; search_path pinned) ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.jwt_claim_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    NULLIF(btrim(COALESCE(auth.jwt()->'app_metadata'->>'role', '')), ''),
    NULLIF(btrim(COALESCE(auth.jwt()->'user_metadata'->>'role', '')), ''),
    'customer'
  );
$$;

CREATE OR REPLACE FUNCTION public.is_privileged_reader()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.jwt_claim_role() IN ('auditor', 'admin', 'fraud_analyst');
$$;

CREATE OR REPLACE FUNCTION public.is_auditor_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.jwt_claim_role() IN ('auditor', 'admin');
$$;

-- ── New user → profile + default wallet ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, display_name, role, phone)
  VALUES (
    NEW.id,
    COALESCE(
      NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'full_name', '')), ''),
      split_part(COALESCE(NEW.email, 'user'), '@', 1)
    ),
    COALESCE(NULLIF(btrim(COALESCE(NEW.raw_app_meta_data->>'role', '')), ''), 'customer'),
    NULLIF(btrim(COALESCE(NEW.raw_user_meta_data->>'phone', '')), '')
  )
  ON CONFLICT (id) DO UPDATE SET
    display_name = COALESCE(EXCLUDED.display_name, public.profiles.display_name),
    updated_at = now();

  INSERT INTO public.wallets (user_id, currency)
  SELECT NEW.id, 'KES'
  WHERE NOT EXISTS (SELECT 1 FROM public.wallets w WHERE w.user_id = NEW.id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();

-- ── Drop permissive / demo policies ───────────────────────────────────────────
DROP POLICY IF EXISTS "ledger_rw_demo" ON public.ledger_entries;
DROP POLICY IF EXISTS "recon_read_demo" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_insert_demo" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "fraud_service" ON public.fraud_logs;
DROP POLICY IF EXISTS "txn_service" ON public.transactions;
DROP POLICY IF EXISTS "risk_service" ON public.risk_events;
DROP POLICY IF EXISTS "webhook_service" ON public.webhook_events;
DROP POLICY IF EXISTS "ai_session_self" ON public.ai_sessions;

-- ── Ledger: owner-scoped writes; staff read-all ───────────────────────────────
CREATE POLICY "ledger_select_policy" ON public.ledger_entries
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()::text
    OR public.is_privileged_reader()
  );

CREATE POLICY "ledger_insert_policy" ON public.ledger_entries
  FOR INSERT TO authenticated
  WITH CHECK (
    owner_id IS NULL
    OR owner_id = auth.uid()::text
  );

-- ── Reconciliation: staff read; auditor/admin insert ────────────────────────────
CREATE POLICY "recon_select_policy" ON public.reconciliation_logs
  FOR SELECT TO authenticated
  USING (public.is_privileged_reader());

CREATE POLICY "recon_insert_policy" ON public.reconciliation_logs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_auditor_admin());

-- ── Fraud / risk / webhooks: staff read; no direct client writes ───────────────
CREATE POLICY "fraud_logs_select" ON public.fraud_logs
  FOR SELECT TO authenticated
  USING (
    public.is_privileged_reader()
    OR user_id = auth.uid()
  );

CREATE POLICY "fraud_logs_insert_deny" ON public.fraud_logs
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "risk_events_select" ON public.risk_events
  FOR SELECT TO authenticated
  USING (public.is_privileged_reader());

CREATE POLICY "risk_events_insert_deny" ON public.risk_events
  FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "webhook_events_select" ON public.webhook_events
  FOR SELECT TO authenticated
  USING (public.is_auditor_admin());

CREATE POLICY "webhook_events_insert_deny" ON public.webhook_events
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- ── Transactions: operations staff only (table unused by SPA today) ─────────────
CREATE POLICY "transactions_select" ON public.transactions
  FOR SELECT TO authenticated
  USING (public.is_privileged_reader());

CREATE POLICY "transactions_insert_deny" ON public.transactions
  FOR INSERT TO authenticated
  WITH CHECK (false);

-- ── AI sessions: own rows + staff ─────────────────────────────────────────────
CREATE POLICY "ai_sessions_select" ON public.ai_sessions
  FOR SELECT TO authenticated
  USING (
    user_id IS NULL
    OR user_id = auth.uid()
    OR public.is_privileged_reader()
  );

CREATE POLICY "ai_sessions_insert" ON public.ai_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id IS NULL
    OR user_id = auth.uid()
  );
