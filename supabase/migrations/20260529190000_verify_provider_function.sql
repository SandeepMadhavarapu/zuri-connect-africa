-- Migration: 20260529190000_verify_provider_function.sql
--
-- Creates verify_provider_payment_method(), a SECURITY DEFINER Postgres function
-- that atomically writes to three tables in a single transaction:
--   1. provider_payment_methods       — sets verification_status='verified',
--                                       last_verified_at, verified_by
--   2. provider_verification_sources  — inserts an evidence row
--   3. provider_audit_events          — inserts a before/after audit row
--
-- Atomicity guarantee: all three writes execute inside a single plpgsql block.
-- If any statement raises an exception, Postgres rolls back the entire
-- transaction automatically. The calling Edge Function must NOT split these
-- writes across multiple RPCs — doing so would break the atomicity guarantee
-- and could leave a "verified" method with no evidence trail.
--
-- SECURITY DEFINER: the function runs with the privileges of its creator
-- (service_role), bypassing RLS on all three target tables.  This is safe here
-- because:
--   (a) REVOKE EXECUTE below blocks anon and authenticated from calling it
--   (b) the calling Edge Function (admin-verify-provider) enforces
--       app_metadata.role === 'admin' in application code before calling .rpc()
--   (c) SET search_path = public is explicit to prevent schema-confusion injection
--
-- The caller (admin-verify-provider Edge Function) is responsible for:
--   • verifying Bearer JWT (401 if missing/invalid)
--   • verifying app_metadata.role === 'admin' (403 otherwise)
--   • validating all inputs with Zod before forwarding to this function

CREATE OR REPLACE FUNCTION public.verify_provider_payment_method(
  p_payment_method_id   uuid,
  p_admin_user_id       uuid,
  p_source_type         text,
  p_source_reference    text,
  p_evidence_hash       text DEFAULT NULL,
  p_attestation         jsonb DEFAULT '{}'::jsonb,
  p_notes               text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_before    jsonb;
  v_after     jsonb;
  v_source_id uuid;
  v_audit_id  bigint;
BEGIN
  -- Validate source_type before doing anything
  IF p_source_type NOT IN (
    'safaricom_directory', 'provider_letter', 'utility_invoice',
    'field_visit', 'partner_api', 'signed_contract'
  ) THEN
    RAISE EXCEPTION 'invalid_source_type: %', p_source_type
      USING ERRCODE = '22023';
  END IF;

  -- Capture before state
  SELECT to_jsonb(row(*))
    INTO v_before
    FROM provider_payment_methods
    WHERE id = p_payment_method_id;

  IF v_before IS NULL THEN
    RAISE EXCEPTION 'payment_method_not_found: %', p_payment_method_id
      USING ERRCODE = 'P0002';
  END IF;

  -- Update payment method (transition to verified)
  UPDATE provider_payment_methods
    SET verification_status = 'verified',
        last_verified_at    = now(),
        verified_by         = p_admin_user_id,
        notes               = COALESCE(p_notes, notes),
        updated_at          = now()
    WHERE id = p_payment_method_id;

  -- Insert evidence
  INSERT INTO provider_verification_sources (
    payment_method_id, source_type, source_reference, evidence_hash,
    verified_at, verified_by, attestation
  ) VALUES (
    p_payment_method_id, p_source_type, p_source_reference,
    p_evidence_hash, now(), p_admin_user_id, p_attestation
  )
  RETURNING id INTO v_source_id;

  -- Capture after state
  SELECT to_jsonb(row(*))
    INTO v_after
    FROM provider_payment_methods
    WHERE id = p_payment_method_id;

  -- Insert audit event
  INSERT INTO provider_audit_events (
    payment_method_id, actor_id, actor_role, action, before, after, at
  ) VALUES (
    p_payment_method_id, p_admin_user_id, 'admin', 'verify',
    v_before, v_after, now()
  )
  RETURNING id INTO v_audit_id;

  -- Return success summary
  RETURN jsonb_build_object(
    'payment_method_id',      p_payment_method_id,
    'verification_source_id', v_source_id,
    'audit_event_id',         v_audit_id,
    'verified_at',            now()
  );
END;
$$;

-- Grant execute to service_role only.
-- The Edge Function uses service_role with a separate admin-role check in
-- application code.  Never grant to authenticated or anon — those roles
-- cannot bypass RLS on the underlying tables anyway, but the REVOKE makes
-- the intent explicit and prevents accidental future grants from enabling
-- unauthenticated writes.
REVOKE EXECUTE ON FUNCTION public.verify_provider_payment_method(
  uuid, uuid, text, text, text, jsonb, text
) FROM public, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.verify_provider_payment_method(
  uuid, uuid, text, text, text, jsonb, text
) TO service_role;
