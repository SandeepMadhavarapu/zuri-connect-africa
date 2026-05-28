-- ============================================================
-- RLS LOCKDOWN MIGRATION
-- Forces Row Level Security on every financial table.
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Helper: get current user's auth.uid() safely
CREATE OR REPLACE FUNCTION public.current_user_id()
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid();
$$;

-- ============================================================
-- LEDGER_ENTRIES — financial transactions
-- owner_id is TEXT in schema; compare to auth.uid()::text
-- ============================================================

ALTER TABLE IF EXISTS public.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ledger_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ledger_rw_demo" ON public.ledger_entries;
DROP POLICY IF EXISTS "ledger_select_scoped" ON public.ledger_entries;
DROP POLICY IF EXISTS "ledger_insert_own_owner" ON public.ledger_entries;
DROP POLICY IF EXISTS "ledger_deny_anon" ON public.ledger_entries;
DROP POLICY IF EXISTS "ledger_select_policy" ON public.ledger_entries;
DROP POLICY IF EXISTS "ledger_insert_policy" ON public.ledger_entries;
DROP POLICY IF EXISTS "Users read own ledger entries" ON public.ledger_entries;
DROP POLICY IF EXISTS "Users insert own ledger entries" ON public.ledger_entries;
DROP POLICY IF EXISTS "No ledger updates by users" ON public.ledger_entries;
DROP POLICY IF EXISTS "No ledger deletes by users" ON public.ledger_entries;

CREATE POLICY "Users read own ledger entries"
  ON public.ledger_entries FOR SELECT
  USING (owner_id = auth.uid()::text OR auth.role() = 'service_role');

CREATE POLICY "Users insert own ledger entries"
  ON public.ledger_entries FOR INSERT
  WITH CHECK (owner_id = auth.uid()::text OR auth.role() = 'service_role');

CREATE POLICY "No ledger updates by users"
  ON public.ledger_entries FOR UPDATE
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "No ledger deletes by users"
  ON public.ledger_entries FOR DELETE
  USING (auth.role() = 'service_role');

-- ============================================================
-- OTP_RECORDS — phone verification codes
-- ============================================================

ALTER TABLE IF EXISTS public.otp_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.otp_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "otp_deny" ON public.otp_records;
DROP POLICY IF EXISTS "Service role manages otp records" ON public.otp_records;
DROP POLICY IF EXISTS "Deny client access to otp_records" ON public.otp_records;

CREATE POLICY "Service role manages otp records"
  ON public.otp_records FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- PROFILES
-- ============================================================

ALTER TABLE IF EXISTS public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.profiles FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles_self" ON public.profiles;

CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  USING (id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "profiles_insert_own"
  ON public.profiles FOR INSERT
  WITH CHECK (id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "profiles_update_own"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid() OR auth.role() = 'service_role')
  WITH CHECK (id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "profiles_delete_own"
  ON public.profiles FOR DELETE
  USING (id = auth.uid() OR auth.role() = 'service_role');

-- ============================================================
-- WALLETS
-- ============================================================

ALTER TABLE IF EXISTS public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.wallets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "wallets_self" ON public.wallets;

CREATE POLICY "wallets_select_own"
  ON public.wallets FOR SELECT
  USING (user_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "wallets_insert_own"
  ON public.wallets FOR INSERT
  WITH CHECK (user_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "wallets_update_own"
  ON public.wallets FOR UPDATE
  USING (user_id = auth.uid() OR auth.role() = 'service_role')
  WITH CHECK (user_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "wallets_delete_service"
  ON public.wallets FOR DELETE
  USING (auth.role() = 'service_role');

-- ============================================================
-- RECONCILIATION_LOGS — backend / ops only (no user_id column)
-- ============================================================

ALTER TABLE IF EXISTS public.reconciliation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.reconciliation_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recon_read_demo" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_insert_demo" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_select_authenticated" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_insert_authenticated" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_deny_anon" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_select_policy" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "recon_insert_policy" ON public.reconciliation_logs;
DROP POLICY IF EXISTS "reconciliation_logs_service_only" ON public.reconciliation_logs;

CREATE POLICY "reconciliation_logs_service_only"
  ON public.reconciliation_logs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- FRAUD_LOGS
-- ============================================================

ALTER TABLE IF EXISTS public.fraud_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.fraud_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "fraud_service" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_select_scoped" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_insert_deny_client" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_logs_select" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_logs_insert_deny" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_logs_select_own" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_logs_insert_service" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_logs_update_service" ON public.fraud_logs;
DROP POLICY IF EXISTS "fraud_logs_delete_service" ON public.fraud_logs;

CREATE POLICY "fraud_logs_select_own"
  ON public.fraud_logs FOR SELECT
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

CREATE POLICY "fraud_logs_insert_service"
  ON public.fraud_logs FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "fraud_logs_update_service"
  ON public.fraud_logs FOR UPDATE
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "fraud_logs_delete_service"
  ON public.fraud_logs FOR DELETE
  USING (auth.role() = 'service_role');

-- ============================================================
-- NOTIFICATIONS
-- ============================================================

ALTER TABLE IF EXISTS public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "notif_self" ON public.notifications;

CREATE POLICY "notifications_select_own"
  ON public.notifications FOR SELECT
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

CREATE POLICY "notifications_insert_own"
  ON public.notifications FOR INSERT
  WITH CHECK (user_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "notifications_update_own"
  ON public.notifications FOR UPDATE
  USING (user_id = auth.uid() OR auth.role() = 'service_role')
  WITH CHECK (user_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "notifications_delete_own"
  ON public.notifications FOR DELETE
  USING (user_id = auth.uid() OR auth.role() = 'service_role');

-- ============================================================
-- TRANSACTIONS — no per-user column; service role only
-- ============================================================

ALTER TABLE IF EXISTS public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.transactions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "txn_service" ON public.transactions;
DROP POLICY IF EXISTS "txn_select_authenticated" ON public.transactions;
DROP POLICY IF EXISTS "txn_insert_deny_client" ON public.transactions;
DROP POLICY IF EXISTS "txn_update_deny_client" ON public.transactions;
DROP POLICY IF EXISTS "transactions_select" ON public.transactions;
DROP POLICY IF EXISTS "transactions_insert_deny" ON public.transactions;
DROP POLICY IF EXISTS "transactions_service_only" ON public.transactions;

CREATE POLICY "transactions_service_only"
  ON public.transactions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- DEVICE_SESSIONS
-- ============================================================

ALTER TABLE IF EXISTS public.device_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.device_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "device_self" ON public.device_sessions;

CREATE POLICY "device_sessions_select_own"
  ON public.device_sessions FOR SELECT
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

CREATE POLICY "device_sessions_insert_own"
  ON public.device_sessions FOR INSERT
  WITH CHECK (user_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "device_sessions_update_own"
  ON public.device_sessions FOR UPDATE
  USING (user_id = auth.uid() OR auth.role() = 'service_role')
  WITH CHECK (user_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "device_sessions_delete_own"
  ON public.device_sessions FOR DELETE
  USING (user_id = auth.uid() OR auth.role() = 'service_role');

-- ============================================================
-- RISK_EVENTS
-- ============================================================

ALTER TABLE IF EXISTS public.risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.risk_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "risk_service" ON public.risk_events;
DROP POLICY IF EXISTS "risk_select_ops_or_self" ON public.risk_events;
DROP POLICY IF EXISTS "risk_insert_deny_client" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_select" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_insert_deny" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_select_own" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_insert_service" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_update_service" ON public.risk_events;
DROP POLICY IF EXISTS "risk_events_delete_service" ON public.risk_events;

CREATE POLICY "risk_events_select_own"
  ON public.risk_events FOR SELECT
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

CREATE POLICY "risk_events_insert_service"
  ON public.risk_events FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "risk_events_update_service"
  ON public.risk_events FOR UPDATE
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "risk_events_delete_service"
  ON public.risk_events FOR DELETE
  USING (auth.role() = 'service_role');

-- ============================================================
-- WEBHOOK_EVENTS — ingress; service role only
-- ============================================================

ALTER TABLE IF EXISTS public.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.webhook_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "webhook_service" ON public.webhook_events;
DROP POLICY IF EXISTS "webhook_deny_authenticated" ON public.webhook_events;
DROP POLICY IF EXISTS "webhook_deny_anon" ON public.webhook_events;
DROP POLICY IF EXISTS "webhook_events_select" ON public.webhook_events;
DROP POLICY IF EXISTS "webhook_events_insert_deny" ON public.webhook_events;
DROP POLICY IF EXISTS "webhook_events_service_only" ON public.webhook_events;

CREATE POLICY "webhook_events_service_only"
  ON public.webhook_events FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- AI_SESSIONS
-- ============================================================

ALTER TABLE IF EXISTS public.ai_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ai_sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_session_self" ON public.ai_sessions;
DROP POLICY IF EXISTS "ai_sessions_select" ON public.ai_sessions;
DROP POLICY IF EXISTS "ai_sessions_insert" ON public.ai_sessions;
DROP POLICY IF EXISTS "ai_sessions_select_own" ON public.ai_sessions;
DROP POLICY IF EXISTS "ai_sessions_insert_own" ON public.ai_sessions;
DROP POLICY IF EXISTS "ai_sessions_update_own" ON public.ai_sessions;
DROP POLICY IF EXISTS "ai_sessions_delete_own" ON public.ai_sessions;

CREATE POLICY "ai_sessions_select_own"
  ON public.ai_sessions FOR SELECT
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

CREATE POLICY "ai_sessions_insert_own"
  ON public.ai_sessions FOR INSERT
  WITH CHECK (
    (user_id IS NULL OR user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

CREATE POLICY "ai_sessions_update_own"
  ON public.ai_sessions FOR UPDATE
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  )
  WITH CHECK (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

CREATE POLICY "ai_sessions_delete_own"
  ON public.ai_sessions FOR DELETE
  USING (
    (user_id IS NOT NULL AND user_id = auth.uid())
    OR auth.role() = 'service_role'
  );

-- ============================================================
-- IDEMPOTENCY_KEYS
-- ============================================================

ALTER TABLE IF EXISTS public.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.idempotency_keys FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own idempotency keys" ON public.idempotency_keys;
DROP POLICY IF EXISTS "Users can insert own idempotency keys" ON public.idempotency_keys;
DROP POLICY IF EXISTS "Users can update own idempotency keys" ON public.idempotency_keys;
DROP POLICY IF EXISTS "idempotency_keys_select_own" ON public.idempotency_keys;
DROP POLICY IF EXISTS "idempotency_keys_insert_own" ON public.idempotency_keys;
DROP POLICY IF EXISTS "idempotency_keys_update_own" ON public.idempotency_keys;
DROP POLICY IF EXISTS "idempotency_keys_delete_own" ON public.idempotency_keys;

CREATE POLICY "idempotency_keys_select_own"
  ON public.idempotency_keys FOR SELECT
  USING (owner_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "idempotency_keys_insert_own"
  ON public.idempotency_keys FOR INSERT
  WITH CHECK (owner_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "idempotency_keys_update_own"
  ON public.idempotency_keys FOR UPDATE
  USING (owner_id = auth.uid() OR auth.role() = 'service_role')
  WITH CHECK (owner_id = auth.uid() OR auth.role() = 'service_role');

CREATE POLICY "idempotency_keys_delete_own"
  ON public.idempotency_keys FOR DELETE
  USING (owner_id = auth.uid() OR auth.role() = 'service_role');

-- ============================================================
-- RATE_LIMITS — existing service-role policy; force RLS
-- ============================================================

ALTER TABLE IF EXISTS public.rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rate_limits FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role can manage rate limits" ON public.rate_limits;

CREATE POLICY "Service role can manage rate limits"
  ON public.rate_limits FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- ============================================================
-- WEBHOOK_NONCES
-- ============================================================

ALTER TABLE IF EXISTS public.webhook_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.webhook_nonces FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages webhook nonces" ON public.webhook_nonces;

CREATE POLICY "Service role manages webhook nonces"
  ON public.webhook_nonces FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON FUNCTION public.current_user_id() IS 'Stable helper for auth.uid() in policies and SECURITY DEFINER contexts.';
