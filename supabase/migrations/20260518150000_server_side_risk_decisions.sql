-- Server-side fraud/risk authority for payment initiation.
-- Browser clients may request a payment and display a safe summary, but the
-- database records and enforces that risk decisions are written only by
-- Supabase Edge Functions using service_role.

ALTER TABLE public.pending_payments
  DROP CONSTRAINT IF EXISTS pending_payments_status_valid;

ALTER TABLE public.pending_payments
  ADD CONSTRAINT pending_payments_status_valid
  CHECK (
    status IN (
      'processing',
      'waiting_for_mpesa',
      'step_up_required',
      'succeeded',
      'failed',
      'cancelled',
      'canceled',
      'timeout',
      'review_required',
      'reversed',
      'completed',
      'confirmed',
      'settled'
    )
  ) NOT VALID;

CREATE TABLE IF NOT EXISTS public.risk_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pending_payment_id UUID REFERENCES public.pending_payments(id) ON DELETE SET NULL,
  tx_ref TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'step_up', 'block', 'manual_review')),
  risk_score NUMERIC(5,2) NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  required_step_up TEXT CHECK (required_step_up IS NULL OR required_step_up IN ('otp', 'pin', 'biometric', 'support_review')),
  public_message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_risk_decisions_user_created
  ON public.risk_decisions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_risk_decisions_pending
  ON public.risk_decisions(pending_payment_id);

CREATE TABLE IF NOT EXISTS public.security_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warn', 'error', 'critical')),
  action TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'success' CHECK (outcome IN ('success', 'failure', 'denied', 'pending')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_security_events_user_created
  ON public.security_events(user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_security_events_type_created
  ON public.security_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS public.step_up_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  pending_payment_id UUID NOT NULL REFERENCES public.pending_payments(id) ON DELETE CASCADE,
  challenge_type TEXT NOT NULL CHECK (challenge_type IN ('otp', 'pin', 'biometric', 'support_review')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes'),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_step_up_challenges_user_created
  ON public.step_up_challenges(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_step_up_challenges_pending
  ON public.step_up_challenges(pending_payment_id);

DO $$
DECLARE
  v_table text;
  v_policy record;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['risk_decisions', 'security_events', 'step_up_challenges']
  LOOP
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
  END LOOP;
END $$;

CREATE POLICY "risk_decisions_select_own"
  ON public.risk_decisions FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "risk_decisions_service_role_all"
  ON public.risk_decisions FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, user_id, pending_payment_id, tx_ref, decision, required_step_up, public_message, created_at)
  ON public.risk_decisions TO authenticated;

CREATE POLICY "security_events_select_own"
  ON public.security_events FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "security_events_service_role_all"
  ON public.security_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, user_id, event_type, severity, action, outcome, created_at)
  ON public.security_events TO authenticated;

CREATE POLICY "step_up_challenges_select_own"
  ON public.step_up_challenges FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "step_up_challenges_service_role_all"
  ON public.step_up_challenges FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

GRANT SELECT (id, user_id, pending_payment_id, challenge_type, status, expires_at, created_at)
  ON public.step_up_challenges TO authenticated;

COMMENT ON TABLE public.risk_decisions IS
  'Authoritative server-side fraud/risk decisions for high-risk actions. Browser roles may read safe summaries only and cannot write or override decisions.';
COMMENT ON TABLE public.security_events IS
  'Security event log written by Edge Functions for blocked, reviewed, or escalated actions. Browser roles cannot write events.';
COMMENT ON TABLE public.step_up_challenges IS
  'Server-created step-up verification challenges. Daraja STK Push is not called until a required challenge is satisfied by a server-side flow.';

CREATE OR REPLACE FUNCTION public.reject_risk_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_risk_decisions_no_update ON public.risk_decisions;
CREATE TRIGGER trg_risk_decisions_no_update
  BEFORE UPDATE OR DELETE ON public.risk_decisions
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_risk_evidence_mutation();

DROP TRIGGER IF EXISTS trg_security_events_no_update ON public.security_events;
CREATE TRIGGER trg_security_events_no_update
  BEFORE UPDATE OR DELETE ON public.security_events
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_risk_evidence_mutation();

REVOKE EXECUTE ON FUNCTION public.reject_risk_evidence_mutation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_risk_evidence_mutation() TO service_role;

COMMENT ON FUNCTION public.reject_risk_evidence_mutation() IS
  'TRIGGER-ONLY safety function. Risk decisions and security events are append-only evidence.';
