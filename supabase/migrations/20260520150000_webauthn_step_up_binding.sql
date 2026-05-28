-- Bind WebAuthn challenges to a specific action and (optionally) a step-up
-- challenge so that an assertion proves the user intended to authorize the
-- *exact* action shown in the biometric modal (transaction confirmation).
--
-- This prevents a malicious or XSS-compromised frontend from steering a
-- legitimate biometric ceremony toward a different sensitive action than the
-- user thinks they are approving.
--
-- The single-use behaviour is preserved: server now stamps consumed_at instead
-- of immediately deleting the row, which keeps a short-lived audit trail.

ALTER TABLE public.webauthn_challenges
  ADD COLUMN IF NOT EXISTS action_type TEXT,
  ADD COLUMN IF NOT EXISTS step_up_challenge_id UUID,
  ADD COLUMN IF NOT EXISTS binding_hash TEXT,
  ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'webauthn_challenges_step_up_fkey'
  ) THEN
    ALTER TABLE public.webauthn_challenges
      ADD CONSTRAINT webauthn_challenges_step_up_fkey
      FOREIGN KEY (step_up_challenge_id)
      REFERENCES public.step_up_challenges(id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'webauthn_challenges_action_type_valid'
  ) THEN
    ALTER TABLE public.webauthn_challenges
      ADD CONSTRAINT webauthn_challenges_action_type_valid
      CHECK (
        action_type IS NULL
        OR action_type IN (
          'enrollment',
          'authentication',
          'payment_send',
          'payment_paybill',
          'payment_airtime',
          'payment_bundle',
          'pin_change',
          'pin_setup',
          'pin_reset',
          'security_change'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_step_up
  ON public.webauthn_challenges(step_up_challenge_id)
  WHERE step_up_challenge_id IS NOT NULL;

-- A given step-up challenge can only have one un-consumed WebAuthn challenge at
-- a time. This blocks a malicious frontend from minting several action-bound
-- challenges in parallel and using whichever the user happens to sign.
CREATE UNIQUE INDEX IF NOT EXISTS uq_webauthn_challenges_step_up_open
  ON public.webauthn_challenges(step_up_challenge_id)
  WHERE step_up_challenge_id IS NOT NULL AND consumed_at IS NULL;

COMMENT ON COLUMN public.webauthn_challenges.action_type IS
  'The high-level user action this challenge authorizes (payment_send, pin_change, etc.). Verified by Edge Functions when consuming the assertion.';
COMMENT ON COLUMN public.webauthn_challenges.step_up_challenge_id IS
  'When present, ties this WebAuthn challenge to a payment step-up. The assertion can only complete that exact challenge — replay across other pending payments is impossible.';
COMMENT ON COLUMN public.webauthn_challenges.binding_hash IS
  'SHA-256 of canonical(action_type, step_up_challenge_id, pending_payment_id, amount_minor, recipient_safe). Compared on consume so a re-bound or tampered challenge fails closed.';
COMMENT ON COLUMN public.webauthn_challenges.consumed_at IS
  'Stamped by verify-biometric/complete-step-up when the assertion is accepted. Combined with the partial unique index above, this enforces single-use semantics without immediately deleting the row (short-lived audit trail).';

-- Existing cleanup function deletes by expiry; extend it to also reap consumed
-- rows older than 1 hour so we keep a brief audit window but bound storage.
CREATE OR REPLACE FUNCTION public.cleanup_expired_webauthn_challenges()
RETURNS INTEGER AS $$
DECLARE deleted INTEGER;
BEGIN
  DELETE FROM public.webauthn_challenges
   WHERE expires_at < NOW()
      OR (consumed_at IS NOT NULL AND consumed_at < NOW() - interval '1 hour');
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
