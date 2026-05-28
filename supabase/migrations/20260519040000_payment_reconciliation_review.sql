-- Zuri Connect Africa — manual-review queue support for payment reconciliation.
--
-- Goals:
--   * Add a stable `reason` column on payment_reconciliation_events to give
--     ops a human-readable explanation per row without inferring from event
--     type strings.
--   * Add a safe `payment_reconciliation_review` VIEW that exposes only the
--     non-sensitive fields needed by the admin/ops UI. Raw provider payload
--     hashes are excluded; raw STK callbacks remain hidden in pending_payments.
--   * Restrict the view to service_role and authenticated admin/auditor roles
--     via column-level grants; anon never sees it.

-- 1. Add a reason column (nullable, free-form text) ------------------------
ALTER TABLE public.payment_reconciliation_events
  ADD COLUMN IF NOT EXISTS reason TEXT;

COMMENT ON COLUMN public.payment_reconciliation_events.reason IS
  'Optional human-readable rationale for the reconciliation event (e.g. "amount mismatch", "provider query failed").';

CREATE INDEX IF NOT EXISTS idx_payment_recon_reason
  ON public.payment_reconciliation_events(reason)
  WHERE reason IS NOT NULL;

-- 2. Manual-review queue view ---------------------------------------------
--    Only safe fields are exposed. The view is read-only by virtue of
--    DEFAULT permissions plus REVOKE below.
CREATE OR REPLACE VIEW public.payment_reconciliation_review AS
SELECT
  e.id                              AS event_id,
  e.pending_payment_id              AS pending_payment_id,
  e.external_reference              AS external_reference,
  COALESCE(e.reason, e.event_type)  AS reason,
  e.provider_status                 AS provider_status,
  e.internal_status                 AS internal_status,
  e.amount_match                    AS amount_match,
  e.phone_match                     AS phone_match,
  e.requires_manual_review          AS requires_manual_review,
  e.event_type                      AS event_type,
  e.created_at                      AS created_at,
  pp.tx_ref                         AS tx_ref,
  pp.amount                         AS amount,
  pp.from_phone                     AS from_phone,
  pp.to_phone                       AS to_phone,
  pp.status                         AS pending_status,
  pp.updated_at                     AS pending_updated_at
FROM public.payment_reconciliation_events e
LEFT JOIN public.pending_payments pp
  ON pp.id = e.pending_payment_id
WHERE e.requires_manual_review = TRUE
   OR e.event_type IN (
        'amount_mismatch',
        'phone_mismatch',
        'conflicting_provider_status',
        'late_conflicting_callback',
        'stuck_review_required',
        'stuck_timeout',
        'provider_query_failed'
      );

COMMENT ON VIEW public.payment_reconciliation_review IS
  'Read-only ops/admin manual-review queue. Excludes raw STK callbacks and webhook payloads. Service role + admin/auditor only.';

-- 3. Lock down view permissions -------------------------------------------
REVOKE ALL ON public.payment_reconciliation_review FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_reconciliation_review TO service_role;

-- Authenticated admin/auditor users go through the reconciliation Edge
-- Function (service-role) — they do NOT get direct view access. This keeps
-- one source of truth and one audit trail.
