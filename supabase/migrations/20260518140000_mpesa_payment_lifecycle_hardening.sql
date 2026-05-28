-- M-PESA/Daraja lifecycle hardening.
-- Payment initiation remains pending-only; callback confirmation is the sole
-- production path to succeeded payments and service-role ledger posting.

ALTER TABLE public.pending_payments
  DROP CONSTRAINT IF EXISTS pending_payments_status_valid;

ALTER TABLE public.pending_payments
  ADD CONSTRAINT pending_payments_status_valid
  CHECK (
    status IN (
      'processing',
      'waiting_for_mpesa',
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

CREATE TABLE IF NOT EXISTS public.payment_reconciliation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pending_payment_id UUID NOT NULL REFERENCES public.pending_payments(id) ON DELETE CASCADE,
  external_reference TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  internal_status TEXT NOT NULL,
  amount_match BOOLEAN,
  phone_match BOOLEAN,
  requires_manual_review BOOLEAN NOT NULL DEFAULT FALSE,
  raw_provider_payload_hash TEXT NOT NULL,
  event_type TEXT NOT NULL DEFAULT 'callback',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_recon_pending_created
  ON public.payment_reconciliation_events(pending_payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_recon_external_reference
  ON public.payment_reconciliation_events(external_reference);

CREATE INDEX IF NOT EXISTS idx_payment_recon_manual_review
  ON public.payment_reconciliation_events(requires_manual_review, created_at DESC)
  WHERE requires_manual_review;

CREATE INDEX IF NOT EXISTS idx_payment_recon_payload_hash
  ON public.payment_reconciliation_events(raw_provider_payload_hash);

ALTER TABLE public.payment_reconciliation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_reconciliation_events FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  p record;
BEGIN
  FOR p IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'payment_reconciliation_events'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.payment_reconciliation_events', p.policyname);
  END LOOP;
END $$;

CREATE POLICY "payment_reconciliation_events_service_role_all"
  ON public.payment_reconciliation_events FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON public.payment_reconciliation_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payment_reconciliation_events TO service_role;

COMMENT ON TABLE public.payment_reconciliation_events IS
  'Append-only M-PESA reconciliation trail. Records duplicate callbacks, mismatches, and provider/internal status conflicts without letting browser roles mutate payment state.';
COMMENT ON COLUMN public.payment_reconciliation_events.pending_payment_id IS
  'Server-created pending payment matched by Daraja checkout or merchant request ID.';
COMMENT ON COLUMN public.payment_reconciliation_events.external_reference IS
  'Daraja receipt number when available; otherwise checkout or merchant request ID.';
COMMENT ON COLUMN public.payment_reconciliation_events.requires_manual_review IS
  'True when callback status, amount, or phone does not safely reconcile to the internal pending payment.';

CREATE OR REPLACE FUNCTION public.reject_payment_reconciliation_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'payment_reconciliation_events is append-only; % is not permitted', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_payment_reconciliation_events_no_update ON public.payment_reconciliation_events;
CREATE TRIGGER trg_payment_reconciliation_events_no_update
  BEFORE UPDATE ON public.payment_reconciliation_events
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_payment_reconciliation_event_mutation();

DROP TRIGGER IF EXISTS trg_payment_reconciliation_events_no_delete ON public.payment_reconciliation_events;
CREATE TRIGGER trg_payment_reconciliation_events_no_delete
  BEFORE DELETE ON public.payment_reconciliation_events
  FOR EACH ROW
  EXECUTE FUNCTION public.reject_payment_reconciliation_event_mutation();

COMMENT ON FUNCTION public.reject_payment_reconciliation_event_mutation() IS
  'TRIGGER-ONLY reconciliation safety function. Reconciliation events are append-only evidence.';

CREATE OR REPLACE FUNCTION public.protect_pending_payment_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('succeeded', 'completed', 'confirmed', 'settled', 'reversed', 'review_required')
     AND NEW.status IN ('processing', 'waiting_for_mpesa') THEN
    RAISE EXCEPTION 'terminal pending_payments status cannot be changed back to processing';
  END IF;

  IF OLD.ledger_posted_at IS NOT NULL AND NEW.ledger_posted_at IS NULL THEN
    RAISE EXCEPTION 'pending_payments.ledger_posted_at cannot be cleared after ledger posting';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.protect_pending_payment_status_transition() IS
  'Server-only payment lifecycle guard. Prevents callback-confirmed, reversed, or review-held payments from being moved back to processing.';

REVOKE EXECUTE ON FUNCTION public.reject_payment_reconciliation_event_mutation() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_payment_reconciliation_event_mutation() TO service_role;
