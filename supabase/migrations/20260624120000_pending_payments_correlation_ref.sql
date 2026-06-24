-- MED-3 — debited-but-unmatchable orphan recovery.
--
-- A crash between Daraja accepting the STK push (the user can already pay) and
-- the checkout_request_id / merchant_request_id write-back leaves a pending row
-- with both lookup keys NULL. The callback then 404s as an orphan and the user
-- is debited at M-Pesa with no corresponding internal record.
--
-- Fix: a short, server-generated correlation key that is persisted on the row
-- BEFORE the STK network call and sent as the Daraja STK Push AccountReference.
-- Daraja echoes AccountReference back in the callback, so the webhook handler
-- can re-link an orphaned callback to its pending row as a fallback.
-- See docs/audits/2026-06-money-path-audit.md MED-3.
--
-- ≤12 chars to fit Daraja's AccountReference limit. Unique among NON-NULL values
-- only (pre-existing rows and non-STK rows stay NULL). The user-facing biller
-- account_reference is unchanged and continues to live in
-- pending_payments.metadata.account_reference.

ALTER TABLE public.pending_payments
  ADD COLUMN IF NOT EXISTS correlation_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_payments_correlation_ref
  ON public.pending_payments(correlation_ref)
  WHERE correlation_ref IS NOT NULL;

COMMENT ON COLUMN public.pending_payments.correlation_ref IS
  'Server-generated <=12-char STK Push AccountReference, echoed back by Daraja in the callback (BillRefNumber / CallbackMetadata). MED-3 orphan-recovery correlation key: matched as a fallback when checkout_request_id was never persisted. NOT a user-facing biller reference (that stays in metadata.account_reference).';
