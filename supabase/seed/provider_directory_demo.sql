-- ─────────────────────────────────────────────────────────────────────────────
-- DEMO SEED — provider_directory_demo.sql
-- Zuri Connect Africa — Phase 3 smoke-test seed
--
-- ⚠ DEMO ONLY. Do NOT treat these entries as audit-grade verification.
--   All future entries MUST follow the proper verify_provider_payment_method()
--   flow via the admin-verify-provider Edge Function with real evidence.
--
-- PURPOSE OF THE SEED ADMIN USER
-- ────────────────────────────────
-- This seed creates a system-only attribution user in auth.users:
--   UUID : aaaa0000-0000-0000-0000-000000000001
--   email: seed-admin@zuriconnect.internal
--
-- The seed-admin user is NOT a real person. It:
--   • has no password (encrypted_password IS NULL) and cannot log in
--   • has no real email account and cannot receive mail
--   • has no application permissions (app_metadata.role = 'seed_script',
--     not 'admin' — it cannot call any privileged Edge Function)
--   • exists solely to be the FK target for:
--       provider_verification_sources.verified_by
--       provider_audit_events.actor_id
--     so the audit trail is traceable to a named origin, not an orphan UUID
--
-- The previous approach (session_replication_role=replica + sentinel UUID
-- 00000000-0000-0000-0000-000000000001) was mechanically correct but left
-- an FK reference that pointed nowhere in auth.users — misleading for auditors.
-- This approach is honest: the FK resolves, actor_role='seed_script' marks it.
--
-- In a future migration we may add a check constraint restricting this UUID
-- to seed-only rows, but audit-trail correctness is sufficient for now.
--
-- PURPOSE: seed ONE verified paybill entry so that ZURI_REQUIRE_VERIFIED_PROVIDER
--   can be flipped to 'true' without rejecting every payment. Remove this entry
--   and replace it with real verified entries before public production launch.
--
-- Idempotent: safe to run more than once — each INSERT uses ON CONFLICT DO NOTHING
--   or an existence-guarded DO block.
--
-- Execution: run as postgres (superuser) in Supabase SQL Editor or via psql.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── 0. Seed admin user in auth.users ─────────────────────────────────────────
--    UUID: aaaa0000-0000-0000-0000-000000000001
--    System-only attribution target. No password, no real email, no login.
--    See comment block at the top of this file for full rationale.

INSERT INTO auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
VALUES (
  'aaaa0000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'seed-admin@zuriconnect.internal',
  NULL,
  now(),
  '{"provider":"system","providers":["system"],"role":"seed_script"}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- ── 1. Provider: Kenya Power and Lighting Company ─────────────────────────────
--    Stable UUID: a0000000-0000-0000-0000-000000000001

INSERT INTO public.providers (id, name, category, status)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'Kenya Power and Lighting Company',
  'utility_electricity',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Payment method: KPLC PayBill 888880 ───────────────────────────────────
--    Stable UUID: b0000000-0000-0000-0000-000000000001
--    verified_by is NULL because no real admin verified this entry.
--    The UNIQUE (method_type, shortcode) constraint ensures idempotency.

INSERT INTO public.provider_payment_methods (
  id,
  provider_id,
  method_type,
  shortcode,
  account_reference_label,
  account_reference_format,
  verification_status,
  last_verified_at,
  verified_by,
  notes
)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000001',
  'paybill',
  '888880',
  'Account / Meter number',
  '[0-9A-Z\-]{4,16}',
  'verified',
  now(),
  NULL,
  'DEMO SEED ONLY — replace with verified entry from verify-provider Edge Function before launch.'
)
ON CONFLICT (method_type, shortcode) DO NOTHING;

-- ── 3. Verification source ────────────────────────────────────────────────────
--    provider_verification_sources has no unique constraint, so idempotency
--    is enforced via an existence check in a DO block.
--    verified_by references the seed-admin user (aaaa0000-...) — a real FK,
--    no replication-role bypass required.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.provider_verification_sources
    WHERE payment_method_id = 'b0000000-0000-0000-0000-000000000001'::uuid
      AND source_reference   = 'DEMO_SEED_ONLY_NOT_AUDIT_PROOF'
  ) THEN
    INSERT INTO public.provider_verification_sources (
      payment_method_id,
      source_type,
      source_reference,
      attestation,
      verified_by
    ) VALUES (
      'b0000000-0000-0000-0000-000000000001',
      'safaricom_directory',
      'DEMO_SEED_ONLY_NOT_AUDIT_PROOF',
      '{"seed": true, "audit_grade": false, "purpose": "phase_3_smoke_test"}'::jsonb,
      'aaaa0000-0000-0000-0000-000000000001'
    );
  END IF;
END;
$$;

-- ── 4. Audit event ────────────────────────────────────────────────────────────
--    Captures the `after` state from the actual inserted payment method row.
--    actor_id references the seed-admin user so the audit trail is traceable.
--    actor_role = 'seed_script' distinguishes this from real admin actions.
--    provider_audit_events has no unique constraint, so idempotency is enforced
--    via an existence check.

DO $$
DECLARE
  v_after jsonb;
BEGIN
  SELECT to_jsonb(m) INTO v_after
  FROM public.provider_payment_methods m
  WHERE m.id = 'b0000000-0000-0000-0000-000000000001'::uuid;

  IF NOT EXISTS (
    SELECT 1 FROM public.provider_audit_events
    WHERE payment_method_id = 'b0000000-0000-0000-0000-000000000001'::uuid
      AND action             = 'seed_demo_verified'
  ) THEN
    INSERT INTO public.provider_audit_events (
      payment_method_id,
      actor_id,
      actor_role,
      action,
      before,
      after
    ) VALUES (
      'b0000000-0000-0000-0000-000000000001',
      'aaaa0000-0000-0000-0000-000000000001',
      'seed_script',
      'seed_demo_verified',
      NULL,
      v_after
    );
  END IF;
END;
$$;

COMMIT;
