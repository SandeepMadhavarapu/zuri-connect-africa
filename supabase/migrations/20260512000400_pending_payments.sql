-- Stores pending Daraja STK Push records for webhook correlation.

CREATE TABLE IF NOT EXISTS public.pending_payments (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_ref               TEXT          NOT NULL UNIQUE,
  checkout_request_id  TEXT          UNIQUE,
  merchant_request_id  TEXT,
  amount               NUMERIC(18,2) NOT NULL,
  from_phone           TEXT          NOT NULL,
  to_phone             TEXT          NOT NULL,
  status               TEXT          NOT NULL DEFAULT 'pending',
  result_code          TEXT,
  result_desc          TEXT,
  created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_payments_tx_ref
  ON public.pending_payments(tx_ref);

CREATE INDEX IF NOT EXISTS idx_pending_payments_checkout_id
  ON public.pending_payments(checkout_request_id)
  WHERE checkout_request_id IS NOT NULL;

ALTER TABLE public.pending_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_payments FORCE ROW LEVEL SECURITY;

CREATE POLICY "pending_payments_service_only"
  ON public.pending_payments
  FOR ALL
  USING  (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.pending_payments IS
  'Daraja STK Push pending records. Populated by initiate-payment edge function. Updated by webhook-handler on callback.';
