-- Production security hardening for Zuri Connect Africa.
-- This migration makes sensitive tables least-privilege by default:
-- browser roles may read only owner-scoped rows, while financial,
-- security, OTP, biometric, risk, webhook, reconciliation, and audit
-- writes are performed by Supabase Edge Functions using service_role.

-- Never trust user_metadata for database authorization. Privileged roles
-- must come from JWT app_metadata.role, which normal users cannot edit.
CREATE OR REPLACE FUNCTION public.jwt_claim_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT lower(coalesce(
    nullif(auth.jwt() -> 'app_metadata' ->> 'role', ''),
    'customer'
  ));
$$;

COMMENT ON FUNCTION public.jwt_claim_role() IS
  'Frontend-safe policy helper. Reads role only from JWT app_metadata; user_metadata is intentionally ignored.';

-- Reset every policy on sensitive tables so older demo/client-write
-- policies cannot survive through name drift.
DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'profiles',
    'wallets',
    'ledger_entries',
    'pending_payments',
    'otp_records',
    'pin_hash_metadata',
    'webauthn_credentials',
    'webauthn_challenges',
    'device_sessions',
    'fraud_logs',
    'risk_events',
    'audit_events',
    'webhook_events',
    'webhook_nonces',
    'reconciliation_logs',
    'reconciliation_runs',
    'transactions',
    'ai_sessions',
    'idempotency_keys',
    'rate_limits',
    'notifications'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', v_table);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO service_role', v_table);

      FOR v_policy IN
        SELECT policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_table
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy.policyname, v_table);
      END LOOP;
    END IF;
  END LOOP;
END $$;

-- Owner-scoped, browser-readable profile data. Profile writes remain narrow:
-- users may edit ordinary profile fields, but role escalation is blocked by
-- the existing prevent_profiles_role_escalation trigger and role grants below.
CREATE POLICY "profiles_select_own"
  ON public.profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid());

CREATE POLICY "profiles_update_own_nonprivileged"
  ON public.profiles FOR UPDATE
  TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_service_role_all"
  ON public.profiles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (phone, display_name, updated_at) ON public.profiles TO authenticated;

COMMENT ON TABLE public.profiles IS
  'Sensitive user profile records. Browser clients may read and update only their own non-privileged fields; service_role owns privileged writes.';

-- Wallet balances are server-authoritative. Browser clients can read only
-- their own wallet; they must never update balance_cached directly.
CREATE POLICY "wallets_select_own"
  ON public.wallets FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "wallets_service_role_all"
  ON public.wallets FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.wallets TO authenticated;

COMMENT ON TABLE public.wallets IS
  'Server-authoritative wallet/account balances. Browser clients may read only their own row and must never write balances.';

-- Append-only ledger. Browser clients must never write financial rows or call
-- double-entry posting RPCs; Edge Functions post with service_role only after
-- provider-confirmed payment callbacks.
CREATE POLICY "ledger_entries_select_own"
  ON public.ledger_entries FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid()::text);

CREATE POLICY "ledger_entries_service_role_all"
  ON public.ledger_entries FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.ledger_entries TO authenticated;

COMMENT ON TABLE public.ledger_entries IS
  'Append-only financial ledger. Browser clients must never insert, update, delete, or RPC-post rows; only Supabase Edge Functions using service_role may write after provider confirmation.';

-- Pending payments are the only frontend-visible payment lifecycle state.
-- The browser may read its own payment status but cannot create, finalize,
-- fail, cancel, or reverse payments.
CREATE POLICY "pending_payments_select_own"
  ON public.pending_payments FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "pending_payments_service_role_all"
  ON public.pending_payments FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.pending_payments TO authenticated;

COMMENT ON TABLE public.pending_payments IS
  'Provider payment lifecycle records. Browser clients may read only their own status; all creation, status changes, callback data, and ledger posting markers are service_role-only.';

-- OTP state, biometric challenges, rate limits, webhook nonces, webhook
-- callback records, reconciliation rows, transactions, and system tables are
-- service-owned. No direct browser access is granted.
CREATE POLICY "otp_records_service_role_all"
  ON public.otp_records FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "webauthn_challenges_service_role_all"
  ON public.webauthn_challenges FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "webhook_events_service_role_all"
  ON public.webhook_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "webhook_nonces_service_role_all"
  ON public.webhook_nonces FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "reconciliation_logs_service_role_all"
  ON public.reconciliation_logs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "reconciliation_runs_service_role_all"
  ON public.reconciliation_runs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "transactions_service_role_all"
  ON public.transactions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "rate_limits_service_role_all"
  ON public.rate_limits FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.otp_records IS
  'OTP verification state. Browser clients have no direct access; Edge Functions read and mutate with service_role.';
COMMENT ON TABLE public.webhook_events IS
  'Provider webhook callback records. Browser clients have no access; service_role writes immutable callback payloads and processing state.';
COMMENT ON TABLE public.webhook_nonces IS
  'Webhook replay-protection nonces. Browser clients have no access; service_role records accepted callback signatures.';
COMMENT ON TABLE public.reconciliation_logs IS
  'Financial reconciliation records. Browser clients have no direct access; reconciliation jobs use service_role.';
COMMENT ON TABLE public.reconciliation_runs IS
  'Reconciliation run audit trail. Browser clients have no direct access; scheduled jobs and Edge Functions use service_role.';
COMMENT ON TABLE public.rate_limits IS
  'Distributed rate limiting buckets for Edge Functions. Browser clients have no direct table access.';

-- User-readable security tables. Writes stay with service_role.
CREATE POLICY "pin_hash_metadata_select_own"
  ON public.pin_hash_metadata FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "pin_hash_metadata_service_role_all"
  ON public.pin_hash_metadata FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.pin_hash_metadata TO authenticated;

CREATE POLICY "webauthn_credentials_select_own"
  ON public.webauthn_credentials FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "webauthn_credentials_service_role_all"
  ON public.webauthn_credentials FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.webauthn_credentials TO authenticated;

CREATE POLICY "device_sessions_select_own"
  ON public.device_sessions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "device_sessions_service_role_all"
  ON public.device_sessions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.device_sessions TO authenticated;

CREATE POLICY "fraud_logs_select_own"
  ON public.fraud_logs FOR SELECT
  TO authenticated
  USING (user_id IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "fraud_logs_service_role_all"
  ON public.fraud_logs FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.fraud_logs TO authenticated;

CREATE POLICY "risk_events_select_own"
  ON public.risk_events FOR SELECT
  TO authenticated
  USING (user_id IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "risk_events_service_role_all"
  ON public.risk_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.risk_events TO authenticated;

CREATE POLICY "audit_events_select_own"
  ON public.audit_events FOR SELECT
  TO authenticated
  USING (actor_id IS NOT NULL AND actor_id = auth.uid());

CREATE POLICY "audit_events_service_role_all"
  ON public.audit_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.audit_events TO authenticated;
REVOKE USAGE, SELECT ON SEQUENCE public.audit_events_sequence_number_seq FROM PUBLIC, anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.audit_events_sequence_number_seq TO service_role;

CREATE POLICY "ai_sessions_select_own"
  ON public.ai_sessions FOR SELECT
  TO authenticated
  USING (user_id IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "ai_sessions_service_role_all"
  ON public.ai_sessions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.ai_sessions TO authenticated;

CREATE POLICY "idempotency_keys_select_own"
  ON public.idempotency_keys FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

CREATE POLICY "idempotency_keys_service_role_all"
  ON public.idempotency_keys FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.idempotency_keys TO authenticated;

-- Notifications are user-facing but not security-authoritative. Users may read
-- their own notifications and mark status only; creation remains service-owned.
CREATE POLICY "notifications_select_own"
  ON public.notifications FOR SELECT
  TO authenticated
  USING (user_id IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "notifications_update_own_status"
  ON public.notifications FOR UPDATE
  TO authenticated
  USING (user_id IS NOT NULL AND user_id = auth.uid())
  WITH CHECK (user_id IS NOT NULL AND user_id = auth.uid());

CREATE POLICY "notifications_service_role_all"
  ON public.notifications FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT ON public.notifications TO authenticated;
GRANT UPDATE (status) ON public.notifications TO authenticated;

COMMENT ON TABLE public.audit_events IS
  'Append-only security and compliance audit log. Browser clients may read only their own actor rows; inserts, updates, and deletes are service_role-only.';
COMMENT ON TABLE public.ai_sessions IS
  'AI conversation/action metadata. Browser clients may read only their own rows; AI calls and logging must go through Edge Functions.';
COMMENT ON TABLE public.idempotency_keys IS
  'Idempotency tracking for financial/security operations. Browser clients may read their own keys only; Edge Functions own writes.';

-- Database-level invariants for money movement and lifecycle state.
ALTER TABLE public.pending_payments ALTER COLUMN status SET DEFAULT 'processing';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ledger_entries_amount_positive'
  ) THEN
    ALTER TABLE public.ledger_entries
      ADD CONSTRAINT ledger_entries_amount_positive
      CHECK (amount > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pending_payments_amount_positive'
  ) THEN
    ALTER TABLE public.pending_payments
      ADD CONSTRAINT pending_payments_amount_positive
      CHECK (amount > 0) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pending_payments_status_valid'
  ) THEN
    ALTER TABLE public.pending_payments
      ADD CONSTRAINT pending_payments_status_valid
      CHECK (
        status IN (
          'processing',
          'succeeded',
          'completed',
          'confirmed',
          'settled',
          'failed',
          'cancelled',
          'canceled',
          'timeout',
          'reversed'
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'wallets_currency_iso_4217'
  ) THEN
    ALTER TABLE public.wallets
      ADD CONSTRAINT wallets_currency_iso_4217
      CHECK (currency ~ '^[A-Z]{3}$') NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_amount_positive_when_present'
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_amount_positive_when_present
      CHECK (amount IS NULL OR amount > 0) NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_idempotency_entry_unique
  ON public.ledger_entries (idempotency_key, entry_type)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_payments_provider_receipt_unique
  ON public.pending_payments (provider_receipt)
  WHERE provider_receipt IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_payments_merchant_request_id_unique
  ON public.pending_payments (merchant_request_id)
  WHERE merchant_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_events_source_payload_hash_unique
  ON public.webhook_events (source, payload_hash)
  WHERE payload_hash IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_nonces_provider_payload_hash_unique
  ON public.webhook_nonces (provider, payload_hash)
  WHERE payload_hash IS NOT NULL;

-- Ledger rows are append-only. A no-op UPDATE is allowed so the existing
-- post_double_entry ON CONFLICT RETURNING path remains idempotent.
CREATE OR REPLACE FUNCTION public.prevent_ledger_entry_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ledger_entries is append-only; DELETE is not permitted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.transaction_ref,
      NEW.entry_type,
      NEW.amount,
      NEW.balance_before,
      NEW.balance_after,
      NEW.account_phone,
      NEW.description,
      NEW.hash,
      NEW.owner_id,
      NEW.created_at,
      NEW.idempotency_key
    ) IS DISTINCT FROM ROW(
      OLD.transaction_ref,
      OLD.entry_type,
      OLD.amount,
      OLD.balance_before,
      OLD.balance_after,
      OLD.account_phone,
      OLD.description,
      OLD.hash,
      OLD.owner_id,
      OLD.created_at,
      OLD.idempotency_key
    ) THEN
      RAISE EXCEPTION 'ledger_entries is append-only; UPDATE is not permitted';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ledger_entries_no_mutation ON public.ledger_entries;
CREATE TRIGGER trg_ledger_entries_no_mutation
  BEFORE UPDATE OR DELETE ON public.ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_ledger_entry_mutation();

COMMENT ON FUNCTION public.prevent_ledger_entry_mutation() IS
  'Server-only ledger safety trigger. Prevents mutable financial history while allowing no-op idempotency updates used by the double-entry RPC.';

CREATE OR REPLACE FUNCTION public.protect_pending_payment_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'completed', 'confirmed', 'settled', 'reversed')
     AND NEW.status IN ('processing') THEN
    RAISE EXCEPTION 'terminal pending_payments status cannot be changed back to processing';
  END IF;

  IF OLD.ledger_posted_at IS NOT NULL AND NEW.ledger_posted_at IS NULL THEN
    RAISE EXCEPTION 'pending_payments.ledger_posted_at cannot be cleared after ledger posting';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pending_payments_status_guard ON public.pending_payments;
CREATE TRIGGER trg_pending_payments_status_guard
  BEFORE UPDATE ON public.pending_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_pending_payment_status_transition();

COMMENT ON FUNCTION public.protect_pending_payment_status_transition() IS
  'Server-only payment lifecycle guard. Prevents confirmed/reversed payments from being moved back to processing or losing ledger-posting evidence.';

-- Webhook callback payloads are immutable. The handler may only advance
-- processing metadata on the already-recorded callback row.
CREATE OR REPLACE FUNCTION public.protect_webhook_event_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webhook_events is append-only; DELETE is not permitted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.source, NEW.idempotency_key, NEW.payload_hash, NEW.payload, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.source, OLD.idempotency_key, OLD.payload_hash, OLD.payload, OLD.created_at) THEN
      RAISE EXCEPTION 'webhook_events callback payload fields are immutable';
    END IF;

    IF OLD.status IN ('processed', 'failed', 'rejected')
       AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'terminal webhook_events status cannot be changed';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_webhook_events_immutable ON public.webhook_events;
CREATE TRIGGER trg_webhook_events_immutable
  BEFORE UPDATE OR DELETE ON public.webhook_events
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_webhook_event_immutability();

COMMENT ON FUNCTION public.protect_webhook_event_immutability() IS
  'Server-only webhook safety trigger. Callback payloads are immutable; the handler may only advance processing status and processed_at.';

-- RPC hardening. Revoke by default, then explicitly grant only frontend-safe
-- read helpers to authenticated and server-only mutation functions to service_role.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role;

GRANT EXECUTE ON FUNCTION public.jwt_claim_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_privileged_reader() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_auditor_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_id() TO authenticated;

COMMENT ON FUNCTION public.is_privileged_reader() IS
  'Frontend-safe policy helper. Returns true only for app_metadata-backed privileged roles.';
COMMENT ON FUNCTION public.is_auditor_admin() IS
  'Frontend-safe policy helper. Returns true only for app_metadata-backed auditor/admin roles.';
COMMENT ON FUNCTION public.current_user_id() IS
  'Frontend-safe policy helper for owner-scoped RLS predicates.';

GRANT EXECUTE ON FUNCTION public.verify_audit_chain(BIGINT, BIGINT) TO authenticated;
COMMENT ON FUNCTION public.verify_audit_chain(BIGINT, BIGINT) IS
  'Frontend-safe read-only audit integrity check. Returns chain validity metadata but not audit row payloads.';

DO $$
BEGIN
  IF to_regprocedure('public.post_double_entry(jsonb,jsonb,numeric)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) TO service_role;
    COMMENT ON FUNCTION public.post_double_entry(JSONB, JSONB, NUMERIC) IS
      'SERVER-ONLY financial mutation RPC. Called by Edge Functions with service_role after provider confirmation; never callable by browser roles.';
  END IF;

  IF to_regprocedure('public.post_double_entry(jsonb,jsonb)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.post_double_entry(JSONB, JSONB) TO service_role;
    COMMENT ON FUNCTION public.post_double_entry(JSONB, JSONB) IS
      'SERVER-ONLY legacy financial mutation RPC. Browser roles are revoked; prefer the overdraft-checked JSONB,JSONB,NUMERIC signature.';
  END IF;

  IF to_regprocedure('public.run_reconciliation(text)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.run_reconciliation(TEXT) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.run_reconciliation(TEXT) TO service_role;
    COMMENT ON FUNCTION public.run_reconciliation(TEXT) IS
      'SERVER-ONLY reconciliation RPC. Scheduled jobs and Edge Functions execute with service_role.';
  END IF;

  IF to_regprocedure('public.check_rate_limit(text,text,text,integer,integer,integer)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.check_rate_limit(TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER) TO service_role;
    COMMENT ON FUNCTION public.check_rate_limit(TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER) IS
      'SERVER-ONLY rate-limit mutation RPC. Edge Functions call with service_role before sensitive operations.';
  END IF;

  IF to_regprocedure('public.cleanup_expired_idempotency_keys()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.cleanup_expired_idempotency_keys() IS
      'SERVER-ONLY maintenance RPC. Removes expired idempotency records.';
  END IF;

  IF to_regprocedure('public.cleanup_expired_rate_limits()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.cleanup_expired_rate_limits() IS
      'SERVER-ONLY maintenance RPC. Removes expired rate limit buckets.';
  END IF;

  IF to_regprocedure('public.cleanup_expired_webhook_nonces()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.cleanup_expired_webhook_nonces() IS
      'SERVER-ONLY maintenance RPC. Removes expired webhook replay-protection nonces.';
  END IF;

  IF to_regprocedure('public.cleanup_expired_webauthn_challenges()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.cleanup_expired_webauthn_challenges() IS
      'SERVER-ONLY maintenance RPC. Removes expired biometric/WebAuthn challenges.';
  END IF;

  IF to_regprocedure('public.compute_audit_chain_hash()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.compute_audit_chain_hash() IS
      'TRIGGER-ONLY audit function. Computes append-only audit chain hashes on service_role inserts.';
  END IF;

  IF to_regprocedure('public.reject_audit_mutation()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.reject_audit_mutation() IS
      'TRIGGER-ONLY audit function. Rejects UPDATE and DELETE on audit_events.';
  END IF;

  IF to_regprocedure('public.handle_new_user()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.handle_new_user() IS
      'TRIGGER-ONLY signup bootstrap. Creates profile and wallet records server-side.';
  END IF;

  IF to_regprocedure('public.prevent_profiles_role_escalation()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.prevent_profiles_role_escalation() IS
      'TRIGGER-ONLY profile safety function. Prevents browser-controlled profile role escalation.';
  END IF;

  IF to_regprocedure('public.sanitize_signup_user_metadata()') IS NOT NULL THEN
    COMMENT ON FUNCTION public.sanitize_signup_user_metadata() IS
      'TRIGGER-ONLY auth safety function. Removes client-submitted privileged metadata from new users.';
  END IF;
END $$;

-- Belt-and-suspenders explicit revokes for server-only RPCs after the broad grant.
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_idempotency_keys() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_rate_limits() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_webhook_nonces() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cleanup_expired_webauthn_challenges() FROM PUBLIC, anon, authenticated;
