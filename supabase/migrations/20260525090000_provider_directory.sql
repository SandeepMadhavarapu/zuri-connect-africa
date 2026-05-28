-- Provider Directory schema.
-- Creates five tables for a server-authoritative registry of M-PESA payment
-- destinations (providers, payment methods, verification sources, wrong-number
-- reports, audit events). RLS + REVOKE ensure only service_role can write to the
-- registry; authenticated users can read active/verified entries and submit
-- wrong-number reports.
-- See AUDIT.md §24.1 for the full design rationale.

-- ─── 1. providers ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.providers (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  category    text        NOT NULL,
  status      text        NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','active','suspended','retired')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─── 2. provider_payment_methods ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.provider_payment_methods (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id               uuid        NOT NULL REFERENCES public.providers(id) ON DELETE CASCADE,
  method_type               text        NOT NULL
                            CHECK (method_type IN ('paybill','till','send_money','partner_api')),
  shortcode                 text        NOT NULL,
  account_reference_label   text,
  account_reference_format  text,
  verification_status       text        NOT NULL DEFAULT 'unverified'
                            CHECK (verification_status IN
                              ('unverified','pending_review','verified','suspended')),
  last_verified_at          timestamptz,
  verified_by               uuid        REFERENCES auth.users(id),
  notes                     text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (method_type, shortcode)
);

CREATE INDEX IF NOT EXISTS ix_ppm_status   ON public.provider_payment_methods (verification_status, method_type);
CREATE INDEX IF NOT EXISTS ix_ppm_provider ON public.provider_payment_methods (provider_id);

-- ─── 3. provider_verification_sources ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.provider_verification_sources (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_method_id  uuid        NOT NULL REFERENCES public.provider_payment_methods(id) ON DELETE CASCADE,
  source_type        text        NOT NULL
                     CHECK (source_type IN
                       ('safaricom_directory','provider_letter','utility_invoice',
                        'field_visit','partner_api','signed_contract')),
  source_reference   text        NOT NULL,
  evidence_hash      text,
  verified_at        timestamptz NOT NULL DEFAULT now(),
  verified_by        uuid        NOT NULL REFERENCES auth.users(id),
  attestation        jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- ─── 4. provider_wrong_number_reports ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.provider_wrong_number_reports (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_method_id         uuid        REFERENCES public.provider_payment_methods(id),
  reporter_user_id          uuid        NOT NULL REFERENCES auth.users(id),
  alleged_correct_shortcode text,
  reason                    text        NOT NULL,
  status                    text        NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','investigating','resolved','rejected')),
  created_at                timestamptz NOT NULL DEFAULT now(),
  resolved_at               timestamptz
);

CREATE INDEX IF NOT EXISTS ix_pwnr_reporter ON public.provider_wrong_number_reports (reporter_user_id, created_at DESC);

-- ─── 5. provider_audit_events ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.provider_audit_events (
  id                bigserial   PRIMARY KEY,
  payment_method_id uuid        REFERENCES public.provider_payment_methods(id),
  actor_id          uuid        REFERENCES auth.users(id),
  actor_role        text,
  action            text        NOT NULL,
  before            jsonb,
  after             jsonb,
  at                timestamptz NOT NULL DEFAULT now()
);

-- ─── RLS: enable + force on all five tables ───────────────────────────────────

ALTER TABLE public.providers                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.providers                      FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_payment_methods       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_payment_methods       FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_verification_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_verification_sources  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_wrong_number_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_wrong_number_reports  FORCE  ROW LEVEL SECURITY;
ALTER TABLE public.provider_audit_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_audit_events          FORCE  ROW LEVEL SECURITY;

-- ─── RLS policies ────────────────────────────────────────────────────────────

-- Authenticated users can read providers that are active.
CREATE POLICY p_providers_read_active ON public.providers
  FOR SELECT TO authenticated USING (status = 'active');

-- Authenticated users can read payment methods that are verified.
CREATE POLICY p_ppm_read_verified ON public.provider_payment_methods
  FOR SELECT TO authenticated USING (verification_status = 'verified');

-- Authenticated users can submit wrong-number reports for their own user id.
CREATE POLICY p_pwnr_insert_own ON public.provider_wrong_number_reports
  FOR INSERT TO authenticated WITH CHECK (reporter_user_id = auth.uid());

-- Authenticated users can read only their own wrong-number reports.
CREATE POLICY p_pwnr_read_own ON public.provider_wrong_number_reports
  FOR SELECT TO authenticated USING (reporter_user_id = auth.uid());

-- ─── REVOKE: registry is server-authoritative; clients cannot mutate it ───────

REVOKE INSERT, UPDATE, DELETE ON public.providers                     FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.provider_payment_methods      FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.provider_verification_sources FROM anon, authenticated;
-- Note: INSERT is intentionally NOT revoked on provider_wrong_number_reports;
-- authenticated users can insert via p_pwnr_insert_own above.
REVOKE        UPDATE, DELETE ON public.provider_wrong_number_reports  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.provider_audit_events         FROM anon, authenticated;
