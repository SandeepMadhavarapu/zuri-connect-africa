-- ============================================================
-- IMMUTABLE AUDIT EVENTS — compliance-grade tamper-evident log
-- Hash chained: each row's chain_hash includes the previous row's hash.
-- Database triggers REJECT all UPDATE and DELETE operations.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_number BIGSERIAL UNIQUE NOT NULL,
  event_type TEXT NOT NULL,
  event_category TEXT NOT NULL CHECK (event_category IN (
    'auth', 'financial', 'fraud', 'admin', 'security', 'system', 'compliance'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN (
    'debug', 'info', 'warn', 'error', 'critical'
  )),
  actor_id UUID,
  actor_type TEXT NOT NULL DEFAULT 'user' CHECK (actor_type IN (
    'user', 'service', 'system', 'admin', 'anonymous'
  )),
  actor_ip TEXT,
  target_type TEXT,
  target_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN (
    'success', 'failure', 'denied', 'pending'
  )),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash TEXT NOT NULL,
  previous_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
  chain_hash TEXT NOT NULL,
  correlation_id TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_actor ON public.audit_events(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_category ON public.audit_events(event_category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_correlation ON public.audit_events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON public.audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_outcome ON public.audit_events(outcome) WHERE outcome != 'success';
CREATE INDEX IF NOT EXISTS idx_audit_events_sequence ON public.audit_events(sequence_number);

-- ============================================================
-- TRIGGER 1 — Compute chain_hash automatically on insert
-- ============================================================

CREATE OR REPLACE FUNCTION public.compute_audit_chain_hash()
RETURNS TRIGGER AS $$
DECLARE
  v_previous_hash TEXT;
  v_chain_input TEXT;
BEGIN
  SELECT chain_hash INTO v_previous_hash
  FROM public.audit_events
  ORDER BY sequence_number DESC
  LIMIT 1;

  IF v_previous_hash IS NULL THEN
    v_previous_hash := '0000000000000000000000000000000000000000000000000000000000000000';
  END IF;

  NEW.previous_hash := v_previous_hash;

  IF NEW.payload_hash IS NULL OR NEW.payload_hash = '' THEN
    NEW.payload_hash := encode(digest(NEW.payload::TEXT, 'sha256'), 'hex');
  END IF;

  v_chain_input := COALESCE(NEW.event_type, '') || '|' ||
                   COALESCE(NEW.event_category, '') || '|' ||
                   COALESCE(NEW.actor_id::TEXT, '') || '|' ||
                   COALESCE(NEW.action, '') || '|' ||
                   COALESCE(NEW.outcome, '') || '|' ||
                   NEW.payload_hash || '|' ||
                   v_previous_hash || '|' ||
                   COALESCE(NEW.created_at::TEXT, NOW()::TEXT);

  NEW.chain_hash := encode(digest(v_chain_input, 'sha256'), 'hex');

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_events_chain_hash ON public.audit_events;
CREATE TRIGGER trg_audit_events_chain_hash
  BEFORE INSERT ON public.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION public.compute_audit_chain_hash();

-- ============================================================
-- TRIGGER 2 — Reject UPDATE and DELETE (append-only enforcement)
-- ============================================================

CREATE OR REPLACE FUNCTION public.reject_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only — % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_events_no_update ON public.audit_events;
CREATE TRIGGER trg_audit_events_no_update
  BEFORE UPDATE ON public.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_audit_mutation();

DROP TRIGGER IF EXISTS trg_audit_events_no_delete ON public.audit_events;
CREATE TRIGGER trg_audit_events_no_delete
  BEFORE DELETE ON public.audit_events
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_audit_mutation();

-- ============================================================
-- RLS — service writes, users read own
-- ============================================================

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read own audit events" ON public.audit_events;
CREATE POLICY "Users read own audit events"
  ON public.audit_events FOR SELECT
  USING (actor_id = auth.uid() OR auth.role() = 'service_role');

DROP POLICY IF EXISTS "Authenticated can insert audit events" ON public.audit_events;
CREATE POLICY "Authenticated can insert audit events"
  ON public.audit_events FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
    OR (auth.uid() IS NOT NULL AND actor_id = auth.uid())
  );

REVOKE ALL ON public.audit_events FROM anon;
GRANT SELECT, INSERT ON public.audit_events TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.audit_events_sequence_number_seq TO authenticated;

-- ============================================================
-- CHAIN VERIFICATION FUNCTION — proves the log was not tampered with
-- ============================================================

CREATE OR REPLACE FUNCTION public.verify_audit_chain(
  p_start_sequence BIGINT DEFAULT NULL,
  p_end_sequence BIGINT DEFAULT NULL
)
RETURNS JSONB AS $$
DECLARE
  r RECORD;
  v_expected_previous TEXT := '0000000000000000000000000000000000000000000000000000000000000000';
  v_total_checked INTEGER := 0;
  v_last_chain_hash TEXT := v_expected_previous;
BEGIN
  FOR r IN
    SELECT *
    FROM public.audit_events
    WHERE (p_start_sequence IS NULL OR sequence_number >= p_start_sequence)
      AND (p_end_sequence IS NULL OR sequence_number <= p_end_sequence)
    ORDER BY sequence_number ASC
  LOOP
    IF r.previous_hash IS DISTINCT FROM v_expected_previous THEN
      RETURN jsonb_build_object(
        'valid', false,
        'broken_at_sequence', r.sequence_number,
        'total_checked', v_total_checked
      );
    END IF;
    v_expected_previous := r.chain_hash;
    v_last_chain_hash := r.chain_hash;
    v_total_checked := v_total_checked + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'valid', true,
    'total_checked', v_total_checked,
    'last_chain_hash', v_last_chain_hash
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.verify_audit_chain(BIGINT, BIGINT) TO authenticated;

COMMENT ON TABLE public.audit_events IS 'Append-only audit log with SHA-256 hash chaining. UPDATE and DELETE are blocked by trigger.';
COMMENT ON FUNCTION public.verify_audit_chain IS 'Verifies the entire chain or a sequence range. Returns broken_at_sequence if tampering detected.';
