-- Zuri Connect Africa — production-leaning RLS tightening (replaces demo-wide-open finance policies)
-- Apply after 20250509000000_init_zuri_schema.sql
-- Service-role keys (Edge Functions) bypass RLS; anon client writes to finance tables are removed.

-- ── Ledger: no anonymous access; users see own postings; admins/fraud ops see all ─────────────
DROP POLICY IF EXISTS "ledger_rw_demo" ON public.ledger_entries;

CREATE POLICY "ledger_select_scoped"
  ON public.ledger_entries FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(coalesce(p.role, '')) IN ('admin', 'fraud_analyst')
    )
  );

CREATE POLICY "ledger_insert_own_owner"
  ON public.ledger_entries FOR INSERT TO authenticated
  WITH CHECK (
    owner_id IS NOT NULL
    AND owner_id = auth.uid()::text
  );

CREATE POLICY "ledger_deny_anon"
  ON public.ledger_entries FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

-- ── Reconciliation logs: authenticated clients may run demo reconciliation jobs; anon denied ────
DROP POLICY IF EXISTS "recon_read_demo" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_insert_demo" ON public.reconciliation_logs;

CREATE POLICY "recon_select_authenticated"
  ON public.reconciliation_logs FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "recon_insert_authenticated"
  ON public.reconciliation_logs FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "recon_deny_anon"
  ON public.reconciliation_logs FOR ALL TO anon
  USING (false)
  WITH CHECK (false);

-- ── Fraud logs: self-read + ops; no client-side inserts (Edge/service role only) ─────────────
DROP POLICY IF EXISTS "fraud_service" ON public.fraud_logs;

CREATE POLICY "fraud_select_scoped"
  ON public.fraud_logs FOR SELECT TO authenticated
  USING (
    user_id IS NULL
    OR user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(coalesce(p.role, '')) IN ('admin', 'fraud_analyst')
    )
  );

CREATE POLICY "fraud_insert_deny_client"
  ON public.fraud_logs FOR INSERT TO authenticated
  WITH CHECK (false);

-- ── Risk events: restrict broad read/write from end users ────────────────────────────────────
DROP POLICY IF EXISTS "risk_service" ON public.risk_events;

CREATE POLICY "risk_select_ops_or_self"
  ON public.risk_events FOR SELECT TO authenticated
  USING (
    user_id IS NULL
    OR user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND lower(coalesce(p.role, '')) IN ('admin', 'fraud_analyst')
    )
  );

CREATE POLICY "risk_insert_deny_client"
  ON public.risk_events FOR INSERT TO authenticated
  WITH CHECK (false);

-- ── Transactions table: read scoped; writes via service role only ────────────────────────────
DROP POLICY IF EXISTS "txn_service" ON public.transactions;

-- Metadata rows are not yet user-scoped in schema; allow read, block mutating writes from clients.
CREATE POLICY "txn_select_authenticated"
  ON public.transactions FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "txn_insert_deny_client"
  ON public.transactions FOR INSERT TO authenticated
  WITH CHECK (false);

CREATE POLICY "txn_update_deny_client"
  ON public.transactions FOR UPDATE TO authenticated
  USING (false);

-- ── Webhook events: ingress visibility service-role only (clients denied) ─────────────────────
DROP POLICY IF EXISTS "webhook_service" ON public.webhook_events;

CREATE POLICY "webhook_deny_authenticated"
  ON public.webhook_events FOR ALL TO authenticated
  USING (false)
  WITH CHECK (false);

CREATE POLICY "webhook_deny_anon"
  ON public.webhook_events FOR ALL TO anon
  USING (false)
  WITH CHECK (false);
