-- ============================================================
-- SECURITY RLS HARDENING VERIFICATION
-- Run after all migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/security_rls_hardening_verification.sql
--
-- These checks validate catalog-level security invariants for the
-- production RLS hardening migration. They intentionally avoid inserting
-- synthetic financial rows so the script can run against staging safely.
-- ============================================================

\set ON_ERROR_STOP on

CREATE OR REPLACE FUNCTION pg_temp.assert_true(p_condition boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT coalesce(p_condition, false) THEN
    RAISE EXCEPTION 'security_rls_hardening_verification failed: %', p_message;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_false(p_condition boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(p_condition, false) THEN
    RAISE EXCEPTION 'security_rls_hardening_verification failed: %', p_message;
  END IF;
END;
$$;

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
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
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables
  LOOP
    PERFORM pg_temp.assert_true(
      EXISTS (
        SELECT 1
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = v_table
          AND c.relkind = 'r'
          AND c.relrowsecurity
          AND c.relforcerowsecurity
      ),
      format('%I must exist with RLS and FORCE RLS enabled', v_table)
    );
  END LOOP;
END $$;

-- Browser roles cannot directly mutate financial/security-critical tables.
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.ledger_entries', 'INSERT'),
  'authenticated must not INSERT ledger_entries'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.ledger_entries', 'UPDATE'),
  'authenticated must not UPDATE ledger_entries'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.ledger_entries', 'DELETE'),
  'authenticated must not DELETE ledger_entries'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.pending_payments', 'UPDATE'),
  'authenticated must not UPDATE pending_payments status or callback data'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.pending_payments', 'INSERT'),
  'authenticated must not INSERT pending_payments'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.audit_events', 'INSERT'),
  'authenticated must not INSERT security audit logs'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.webhook_events', 'INSERT'),
  'authenticated must not INSERT webhook callback records'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.reconciliation_runs', 'INSERT'),
  'authenticated must not INSERT reconciliation records'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.fraud_logs', 'INSERT'),
  'authenticated must not INSERT fraud decisions'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.risk_events', 'INSERT'),
  'authenticated must not INSERT risk scores'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.otp_records', 'UPDATE'),
  'authenticated must not mutate OTP verification state'
);
SELECT pg_temp.assert_false(
  has_table_privilege('authenticated', 'public.webauthn_credentials', 'UPDATE'),
  'authenticated must not mutate biometric credential state'
);

-- Financial/security mutation RPCs are server-only.
DO $$
BEGIN
  IF to_regprocedure('public.post_double_entry(jsonb,jsonb,numeric)') IS NOT NULL THEN
    PERFORM pg_temp.assert_false(
      has_function_privilege('authenticated', 'public.post_double_entry(jsonb,jsonb,numeric)', 'EXECUTE'),
      'authenticated must not EXECUTE post_double_entry(jsonb,jsonb,numeric)'
    );
    PERFORM pg_temp.assert_true(
      has_function_privilege('service_role', 'public.post_double_entry(jsonb,jsonb,numeric)', 'EXECUTE'),
      'service_role must EXECUTE post_double_entry(jsonb,jsonb,numeric)'
    );
  END IF;

  IF to_regprocedure('public.post_double_entry(jsonb,jsonb)') IS NOT NULL THEN
    PERFORM pg_temp.assert_false(
      has_function_privilege('authenticated', 'public.post_double_entry(jsonb,jsonb)', 'EXECUTE'),
      'authenticated must not EXECUTE legacy post_double_entry(jsonb,jsonb)'
    );
    PERFORM pg_temp.assert_true(
      has_function_privilege('service_role', 'public.post_double_entry(jsonb,jsonb)', 'EXECUTE'),
      'service_role must EXECUTE legacy post_double_entry(jsonb,jsonb)'
    );
  END IF;

  PERFORM pg_temp.assert_false(
    has_function_privilege('authenticated', 'public.run_reconciliation(text)', 'EXECUTE'),
    'authenticated must not EXECUTE run_reconciliation(text)'
  );
  PERFORM pg_temp.assert_true(
    has_function_privilege('service_role', 'public.run_reconciliation(text)', 'EXECUTE'),
    'service_role must EXECUTE run_reconciliation(text)'
  );
END $$;

-- Owner-only read policies must be present for user-visible sensitive rows.
DO $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
  FROM (VALUES
    ('profiles', 'profiles_select_own'),
    ('wallets', 'wallets_select_own'),
    ('ledger_entries', 'ledger_entries_select_own'),
    ('pending_payments', 'pending_payments_select_own'),
    ('audit_events', 'audit_events_select_own'),
    ('fraud_logs', 'fraud_logs_select_own'),
    ('risk_events', 'risk_events_select_own'),
    ('device_sessions', 'device_sessions_select_own'),
    ('webauthn_credentials', 'webauthn_credentials_select_own'),
    ('ai_sessions', 'ai_sessions_select_own'),
    ('idempotency_keys', 'idempotency_keys_select_own')
  ) AS expected(tablename, policyname)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = expected.tablename
      AND p.policyname = expected.policyname
      AND p.cmd = 'SELECT'
      AND p.roles::text LIKE '%authenticated%'
      AND p.qual LIKE '%auth.uid()%'
  );

  PERFORM pg_temp.assert_true(
    v_missing = 0,
    format('%s owner-scoped SELECT policy/policies missing or not auth.uid()-scoped', v_missing)
  );
END $$;

-- No broad contact-lookup policy may leak all profiles.
SELECT pg_temp.assert_false(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'profiles_contacts_read'
  ),
  'profiles_contacts_read must not remain on sensitive profiles'
);

-- Service role keeps the backend operational for required server-side writes.
DO $$
DECLARE
  v_table text;
  v_required_writers text[] := ARRAY[
    'ledger_entries',
    'pending_payments',
    'webhook_events',
    'webhook_nonces',
    'reconciliation_logs',
    'reconciliation_runs',
    'fraud_logs',
    'risk_events',
    'audit_events',
    'otp_records',
    'webauthn_credentials',
    'webauthn_challenges',
    'rate_limits'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_required_writers
  LOOP
    PERFORM pg_temp.assert_true(
      has_table_privilege('service_role', format('public.%I', v_table), 'INSERT')
      AND has_table_privilege('service_role', format('public.%I', v_table), 'UPDATE')
      AND has_table_privilege('service_role', format('public.%I', v_table), 'DELETE'),
      format('service_role must keep INSERT/UPDATE/DELETE on %I', v_table)
    );
  END LOOP;
END $$;

-- Critical constraints and immutable/append-only triggers must exist.
DO $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
  FROM (VALUES
    ('ledger_entries_amount_positive'),
    ('pending_payments_amount_positive'),
    ('pending_payments_status_valid'),
    ('wallets_currency_iso_4217'),
    ('transactions_amount_positive_when_present')
  ) AS expected(conname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = expected.conname
  );

  PERFORM pg_temp.assert_true(
    v_missing = 0,
    format('%s required check constraint(s) missing', v_missing)
  );

  SELECT count(*) INTO v_missing
  FROM (VALUES
    ('trg_ledger_entries_no_mutation'),
    ('trg_pending_payments_status_guard'),
    ('trg_webhook_events_immutable'),
    ('trg_audit_events_no_update'),
    ('trg_audit_events_no_delete')
  ) AS expected(tgname)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = expected.tgname AND NOT tgisinternal
  );

  PERFORM pg_temp.assert_true(
    v_missing = 0,
    format('%s required immutability/append-only trigger(s) missing', v_missing)
  );
END $$;

SELECT 'security_rls_hardening_verification passed' AS result;
