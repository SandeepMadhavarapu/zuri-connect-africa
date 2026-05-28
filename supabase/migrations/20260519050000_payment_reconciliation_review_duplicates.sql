-- Zuri Connect Africa — extend the reconciliation review view to expose
-- duplicate and admin-action events to the admin command center.
--
-- This is a non-destructive CREATE OR REPLACE. The view stays read-only and
-- still excludes raw payloads. Permissions are unchanged (service_role only).

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
        'provider_query_failed',
        'duplicate_callback',
        'admin_review_resolved',
        'admin_escalated_to_support',
        'admin_timeout_acknowledged',
        'admin_retry_provider_query_queued'
      );

REVOKE ALL ON public.payment_reconciliation_review FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.payment_reconciliation_review TO service_role;
