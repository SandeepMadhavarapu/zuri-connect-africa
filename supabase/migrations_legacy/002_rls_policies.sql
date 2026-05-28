-- =============================================================================
-- Zuri Connect Africa — Row-Level Security Policies
-- Migration: 002_rls_policies
-- =============================================================================
-- Security model:
--   • Users can only read/write their own records
--   • Service role bypasses RLS for backend operations
--   • Admin role has read access to most tables for analytics
--   • Append-only tables are readable by owner; inserts allowed; no updates/deletes
--   • Fraud and compliance data is service-role-only
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper function: get current user_id from JWT claim
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth_user_id() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', TRUE)::json->>'sub', '')::UUID;
$$;

-- ---------------------------------------------------------------------------
-- Helper: check if current role is service role or admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION is_service_role() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.claims', TRUE)::json->>'role' IN ('service_role', 'supabase_admin');
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS on all tables
-- ---------------------------------------------------------------------------
ALTER TABLE users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions                ENABLE ROW LEVEL SECURITY;
ALTER TABLE passkeys                ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries          ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_limits          ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements             ENABLE ROW LEVEL SECURITY;
ALTER TABLE reversals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_events            ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_graph_nodes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE fraud_graph_edges       ENABLE ROW LEVEL SECURITY;
ALTER TABLE threat_signals          ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_evaluations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_jobs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE telecom_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications           ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_interactions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_flags        ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log               ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- USERS
-- ===========================================================================
CREATE POLICY "users: owner read"
  ON users FOR SELECT
  USING (id = auth_user_id() OR is_service_role());

CREATE POLICY "users: owner update own non-sensitive fields"
  ON users FOR UPDATE
  USING (id = auth_user_id() OR is_service_role())
  WITH CHECK (id = auth_user_id() OR is_service_role());

-- Only service role can insert new users (auth handles registration)
CREATE POLICY "users: service insert"
  ON users FOR INSERT
  WITH CHECK (is_service_role());

-- ===========================================================================
-- DEVICES
-- ===========================================================================
CREATE POLICY "devices: owner read"
  ON devices FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "devices: owner insert"
  ON devices FOR INSERT
  WITH CHECK (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "devices: service update"
  ON devices FOR UPDATE
  USING (is_service_role());

-- ===========================================================================
-- SESSIONS
-- ===========================================================================
CREATE POLICY "sessions: owner read"
  ON sessions FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "sessions: service all"
  ON sessions FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- PASSKEYS
-- ===========================================================================
CREATE POLICY "passkeys: owner read"
  ON passkeys FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "passkeys: service all"
  ON passkeys FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- ACCOUNTS
-- ===========================================================================
CREATE POLICY "accounts: owner read"
  ON accounts FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

-- Balance updates only via service role (prevents direct balance manipulation)
CREATE POLICY "accounts: service write"
  ON accounts FOR INSERT
  WITH CHECK (is_service_role());

CREATE POLICY "accounts: service update"
  ON accounts FOR UPDATE
  USING (is_service_role());

-- ===========================================================================
-- LEDGER ENTRIES (append-only, owner readable)
-- ===========================================================================
CREATE POLICY "ledger: owner read"
  ON ledger_entries FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "ledger: service insert"
  ON ledger_entries FOR INSERT
  WITH CHECK (is_service_role());

-- UPDATE and DELETE blocked by enforce_append_only() trigger — no policy needed

-- ===========================================================================
-- TRANSACTIONS
-- ===========================================================================
CREATE POLICY "transactions: owner read own"
  ON transactions FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "transactions: service all"
  ON transactions FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- ACCOUNT LIMITS
-- ===========================================================================
CREATE POLICY "limits: owner read"
  ON account_limits FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "limits: service write"
  ON account_limits FOR INSERT
  WITH CHECK (is_service_role());

CREATE POLICY "limits: service update"
  ON account_limits FOR UPDATE
  USING (is_service_role());

-- ===========================================================================
-- SETTLEMENTS (service role only — not user-visible directly)
-- ===========================================================================
CREATE POLICY "settlements: service only"
  ON settlements FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- REVERSALS
-- ===========================================================================
CREATE POLICY "reversals: owner read"
  ON reversals FOR SELECT
  USING (initiated_by = auth_user_id() OR is_service_role());

CREATE POLICY "reversals: owner insert"
  ON reversals FOR INSERT
  WITH CHECK (initiated_by = auth_user_id() OR is_service_role());

CREATE POLICY "reversals: service update"
  ON reversals FOR UPDATE
  USING (is_service_role());

-- ===========================================================================
-- DISPUTES
-- ===========================================================================
CREATE POLICY "disputes: owner read"
  ON disputes FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "disputes: owner insert"
  ON disputes FOR INSERT
  WITH CHECK (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "disputes: service update"
  ON disputes FOR UPDATE
  USING (is_service_role());

-- ===========================================================================
-- FRAUD EVENTS (service role only — do not expose to users)
-- ===========================================================================
CREATE POLICY "fraud_events: service only"
  ON fraud_events FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- FRAUD GRAPH (service role only)
-- ===========================================================================
CREATE POLICY "fraud_graph_nodes: service only"
  ON fraud_graph_nodes FOR ALL
  USING (is_service_role());

CREATE POLICY "fraud_graph_edges: service only"
  ON fraud_graph_edges FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- THREAT SIGNALS (service role only)
-- ===========================================================================
CREATE POLICY "threat_signals: service only"
  ON threat_signals FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- POLICY EVALUATIONS (service role only)
-- ===========================================================================
CREATE POLICY "policy_evaluations: service only"
  ON policy_evaluations FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- WEBHOOK EVENTS (service role only)
-- ===========================================================================
CREATE POLICY "webhook_events: service only"
  ON webhook_events FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- QUEUE JOBS (service role only)
-- ===========================================================================
CREATE POLICY "queue_jobs: service only"
  ON queue_jobs FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- RECONCILIATION (service role only)
-- ===========================================================================
CREATE POLICY "reconciliation_reports: service only"
  ON reconciliation_reports FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- TELECOM EVENTS
-- ===========================================================================
CREATE POLICY "telecom_events: owner read"
  ON telecom_events FOR SELECT
  USING (
    (user_id IS NOT NULL AND user_id = auth_user_id())
    OR is_service_role()
  );

CREATE POLICY "telecom_events: service write"
  ON telecom_events FOR INSERT
  WITH CHECK (is_service_role());

-- ===========================================================================
-- NOTIFICATIONS
-- ===========================================================================
CREATE POLICY "notifications: owner read"
  ON notifications FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "notifications: owner update (mark read)"
  ON notifications FOR UPDATE
  USING (user_id = auth_user_id() OR is_service_role())
  WITH CHECK (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "notifications: service insert"
  ON notifications FOR INSERT
  WITH CHECK (is_service_role());

-- ===========================================================================
-- AI INTERACTIONS (service role only — privacy sensitive)
-- ===========================================================================
CREATE POLICY "ai_interactions: service only"
  ON ai_interactions FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- COMPLIANCE FLAGS (service role only — regulatory data)
-- ===========================================================================
CREATE POLICY "compliance_flags: service only"
  ON compliance_flags FOR ALL
  USING (is_service_role());

-- ===========================================================================
-- AUDIT LOG (owner readable, service insertable, no updates/deletes)
-- ===========================================================================
CREATE POLICY "audit_log: owner read"
  ON audit_log FOR SELECT
  USING (user_id = auth_user_id() OR is_service_role());

CREATE POLICY "audit_log: service insert"
  ON audit_log FOR INSERT
  WITH CHECK (is_service_role());

-- UPDATE and DELETE blocked by enforce_append_only() trigger

-- ===========================================================================
-- Record migration
-- ===========================================================================
INSERT INTO schema_migrations (version, description) VALUES
  ('002', 'RLS policies: user-owned data isolation, service-role admin access, regulatory data restricted');
