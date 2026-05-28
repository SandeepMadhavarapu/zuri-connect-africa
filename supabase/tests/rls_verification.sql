-- ============================================================
-- RLS VERIFICATION (automated checks)
-- Run after migrations, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/rls_verification.sql
-- Or invoke from CI against a migrated database.
-- Fails the script (ERROR) if any invariant is violated.
-- ============================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_missing_rls integer;
  v_missing_force integer;
  v_missing_policies integer;
  v_missing_fn integer;
  v_tbl text;
  v_expected text[] := ARRAY[
    'profiles',
    'wallets',
    'ledger_entries',
    'reconciliation_logs',
    'otp_records',
    'fraud_logs',
    'notifications',
    'transactions',
    'device_sessions',
    'risk_events',
    'webhook_events',
    'ai_sessions',
    'idempotency_keys',
    'rate_limits',
    'webhook_nonces'
  ];
  v_force_expected text[] := ARRAY[
    'profiles',
    'wallets',
    'ledger_entries',
    'reconciliation_logs',
    'otp_records',
    'fraud_logs',
    'notifications',
    'transactions',
    'device_sessions',
    'risk_events',
    'webhook_events',
    'ai_sessions',
    'idempotency_keys',
    'rate_limits',
    'webhook_nonces'
  ];
BEGIN
  SELECT count(*) INTO v_missing_fn
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'current_user_id'
    AND pg_get_function_identity_arguments(p.oid) = '';

  IF v_missing_fn < 1 THEN
    RAISE EXCEPTION 'RLS verification failed: public.current_user_id() is missing';
  END IF;

  SELECT count(*) INTO v_missing_rls
  FROM unnest(v_expected) AS t(tbl)
  LEFT JOIN (
    SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) x ON x.relname = t.tbl
  WHERE x.relname IS NULL OR NOT x.relrowsecurity;

  IF v_missing_rls > 0 THEN
    RAISE EXCEPTION 'RLS verification failed: % public table(s) missing or without RLS enabled', v_missing_rls;
  END IF;

  SELECT count(*) INTO v_missing_force
  FROM unnest(v_force_expected) AS t(tbl)
  INNER JOIN (
    SELECT c.relname, c.relforcerowsecurity
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ) x ON x.relname = t.tbl
  WHERE NOT x.relforcerowsecurity;

  IF v_missing_force > 0 THEN
    RAISE EXCEPTION 'RLS verification failed: % financial table(s) do not have FORCE ROW LEVEL SECURITY', v_missing_force;
  END IF;

  SELECT count(*) INTO v_missing_policies
  FROM unnest(v_expected) AS t(tbl)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_policies pol
    WHERE pol.schemaname = 'public'
      AND pol.tablename = t.tbl
  );

  IF v_missing_policies > 0 THEN
    RAISE EXCEPTION 'RLS verification failed: % table(s) have no policies defined', v_missing_policies;
  END IF;

  FOREACH v_tbl IN ARRAY v_expected
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = v_tbl
        AND c.relkind = 'r'
        AND c.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS verification failed: table % is not RLS-protected', v_tbl;
    END IF;
  END LOOP;

  RAISE NOTICE 'RLS verification passed: all financial tables have RLS + FORCE where required, policies present, current_user_id() exists.';
END $$;

SELECT
  c.relname AS table_name,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS force_rls,
  (SELECT count(*) FROM pg_policies pol WHERE pol.schemaname = 'public' AND pol.tablename = c.relname) AS policy_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
  AND c.relname IN (
    'profiles',
    'wallets',
    'ledger_entries',
    'reconciliation_logs',
    'otp_records',
    'fraud_logs',
    'notifications',
    'transactions',
    'device_sessions',
    'risk_events',
    'webhook_events',
    'ai_sessions',
    'idempotency_keys',
    'rate_limits',
    'webhook_nonces'
  )
ORDER BY c.relname;
