CREATE TABLE IF NOT EXISTS public.reconciliation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL UNIQUE,
  run_type TEXT NOT NULL DEFAULT 'scheduled' CHECK (run_type IN ('scheduled', 'manual', 'on_demand')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'anomaly_detected')),
  total_accounts_checked INTEGER NOT NULL DEFAULT 0,
  total_entries_checked INTEGER NOT NULL DEFAULT 0,
  orphan_debits INTEGER NOT NULL DEFAULT 0,
  orphan_credits INTEGER NOT NULL DEFAULT 0,
  balance_mismatches INTEGER NOT NULL DEFAULT 0,
  broken_hash_chain BOOLEAN NOT NULL DEFAULT FALSE,
  stuck_settlements INTEGER NOT NULL DEFAULT 0,
  audit_chain_valid BOOLEAN NOT NULL DEFAULT TRUE,
  anomalies JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_recon_runs_started ON public.reconciliation_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_runs_status ON public.reconciliation_runs(status);
CREATE INDEX IF NOT EXISTS idx_recon_runs_anomaly ON public.reconciliation_runs(status) WHERE status = 'anomaly_detected';

ALTER TABLE public.reconciliation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reconciliation_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages reconciliation runs" ON public.reconciliation_runs;
CREATE POLICY "Service role manages reconciliation runs"
  ON public.reconciliation_runs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION public.run_reconciliation(p_run_type TEXT DEFAULT 'scheduled')
RETURNS JSONB AS $$
DECLARE
  v_run_id TEXT := 'recon_' || to_char(NOW(), 'YYYYMMDD_HH24MISS') || '_' || substring(gen_random_uuid()::TEXT, 1, 8);
  v_started TIMESTAMPTZ := NOW();
  v_total_accounts INTEGER := 0;
  v_total_entries INTEGER := 0;
  v_orphan_debits INTEGER := 0;
  v_orphan_credits INTEGER := 0;
  v_balance_mismatches INTEGER := 0;
  v_stuck_settlements INTEGER := 0;
  v_anomalies JSONB := '[]'::jsonb;
  v_chain_result JSONB;
  v_chain_valid BOOLEAN := TRUE;
  v_duration_ms INTEGER;
  v_status TEXT;
  r RECORD;
BEGIN
  INSERT INTO public.reconciliation_runs (run_id, run_type, status)
  VALUES (v_run_id, p_run_type, 'running');

  SELECT COUNT(*) INTO v_total_entries FROM public.ledger_entries;
  SELECT COUNT(DISTINCT account_phone) INTO v_total_accounts FROM public.ledger_entries;

  SELECT COUNT(*) INTO v_orphan_debits
  FROM public.ledger_entries d
  WHERE d.entry_type = 'debit'
    AND NOT EXISTS (
      SELECT 1 FROM public.ledger_entries c
      WHERE c.transaction_ref = d.transaction_ref AND c.entry_type = 'credit'
    );

  IF v_orphan_debits > 0 THEN
    v_anomalies := v_anomalies || jsonb_build_object('type', 'orphan_debits', 'count', v_orphan_debits, 'severity', 'critical');
  END IF;

  SELECT COUNT(*) INTO v_orphan_credits
  FROM public.ledger_entries c
  WHERE c.entry_type = 'credit'
    AND NOT EXISTS (
      SELECT 1 FROM public.ledger_entries d
      WHERE d.transaction_ref = c.transaction_ref AND d.entry_type = 'debit'
    );

  IF v_orphan_credits > 0 THEN
    v_anomalies := v_anomalies || jsonb_build_object('type', 'orphan_credits', 'count', v_orphan_credits, 'severity', 'critical');
  END IF;

  FOR r IN
    SELECT
      account_phone,
      SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE -amount END) AS derived_balance,
      (SELECT balance_after FROM public.ledger_entries le2
        WHERE le2.account_phone = le1.account_phone
        ORDER BY created_at DESC, id DESC LIMIT 1) AS recorded_balance
    FROM public.ledger_entries le1
    GROUP BY account_phone
  LOOP
    IF ABS(COALESCE(r.derived_balance, 0) - COALESCE(r.recorded_balance, 0)) > 0.01 THEN
      v_balance_mismatches := v_balance_mismatches + 1;
      v_anomalies := v_anomalies || jsonb_build_object(
        'type', 'balance_mismatch', 'account', r.account_phone,
        'derived', r.derived_balance, 'recorded', r.recorded_balance,
        'drift', r.derived_balance - r.recorded_balance, 'severity', 'critical'
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='transactions') THEN
    EXECUTE 'SELECT COUNT(*) FROM public.transactions WHERE status = ''pending'' AND created_at < NOW() - INTERVAL ''24 hours'''
    INTO v_stuck_settlements;
    IF v_stuck_settlements > 0 THEN
      v_anomalies := v_anomalies || jsonb_build_object('type', 'stuck_settlements', 'count', v_stuck_settlements, 'severity', 'warn');
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.routines WHERE routine_schema='public' AND routine_name='verify_audit_chain') THEN
    SELECT public.verify_audit_chain() INTO v_chain_result;
    v_chain_valid := COALESCE((v_chain_result->>'valid')::BOOLEAN, TRUE);
    IF NOT v_chain_valid THEN
      v_anomalies := v_anomalies || jsonb_build_object('type', 'audit_chain_broken', 'details', v_chain_result, 'severity', 'critical');
    END IF;
  END IF;

  v_duration_ms := EXTRACT(EPOCH FROM (NOW() - v_started)) * 1000;
  v_status := CASE WHEN jsonb_array_length(v_anomalies) > 0 THEN 'anomaly_detected' ELSE 'completed' END;

  UPDATE public.reconciliation_runs
  SET status = v_status,
      total_accounts_checked = v_total_accounts,
      total_entries_checked = v_total_entries,
      orphan_debits = v_orphan_debits,
      orphan_credits = v_orphan_credits,
      balance_mismatches = v_balance_mismatches,
      stuck_settlements = v_stuck_settlements,
      audit_chain_valid = v_chain_valid,
      broken_hash_chain = NOT v_chain_valid,
      anomalies = v_anomalies,
      completed_at = NOW(),
      duration_ms = v_duration_ms
  WHERE run_id = v_run_id;

  IF v_status = 'anomaly_detected' AND EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='audit_events'
  ) THEN
    INSERT INTO public.audit_events (
      event_type, event_category, severity, actor_type, action, outcome, payload, payload_hash
    ) VALUES (
      'reconciliation.anomaly_detected', 'compliance', 'critical', 'system',
      'reconciliation_run', 'failure',
      jsonb_build_object('run_id', v_run_id, 'anomalies', v_anomalies, 'duration_ms', v_duration_ms),
      ''
    );
  END IF;

  RETURN jsonb_build_object(
    'run_id', v_run_id, 'status', v_status, 'duration_ms', v_duration_ms,
    'total_accounts', v_total_accounts, 'total_entries', v_total_entries,
    'orphan_debits', v_orphan_debits, 'orphan_credits', v_orphan_credits,
    'balance_mismatches', v_balance_mismatches, 'stuck_settlements', v_stuck_settlements,
    'audit_chain_valid', v_chain_valid, 'anomalies', v_anomalies
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  PERFORM cron.unschedule('zuri_hourly_reconciliation');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'zuri_hourly_reconciliation',
  '0 * * * *',
  $$ SELECT public.run_reconciliation('scheduled'); $$
);

COMMENT ON TABLE public.reconciliation_runs IS 'Audit trail of every reconciliation run.';
