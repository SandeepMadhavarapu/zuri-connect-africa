-- Prevents users from self-assigning privileged roles via profiles.role.
--
-- WHY: profiles.role is writable by the row owner via the profiles_update_own
-- RLS policy. Although app_metadata.role is the authoritative RBAC source
-- (service-role-only, never user-writable), any code that accidentally falls back
-- to profiles.role would hand the attacker admin access. This trigger closes that
-- residual path entirely by blocking privileged values at the DB layer.
--
-- app_metadata.role remains the ONLY authoritative role source.
-- profiles.role is retained for UI-display purposes but is permanently locked to
-- unprivileged values for non-service-role sessions.

CREATE OR REPLACE FUNCTION public.prevent_profiles_role_escalation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  privileged TEXT[] := ARRAY['admin', 'superuser', 'fraud_analyst', 'auditor', 'system', 'service_role'];
BEGIN
  -- Service role can write any value (needed for legitimate admin provisioning).
  IF current_setting('role', true) = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Block any attempt by a non-service-role session to set a privileged role.
  IF lower(NEW.role) = ANY(privileged) THEN
    RAISE EXCEPTION 'RBAC_VIOLATION: profiles.role may not be set to a privileged value';
  END IF;

  -- Additionally force the value back to 'customer' if it was changed by a user session.
  -- This is defense-in-depth: even if the RAISE is somehow bypassed, the stored value stays safe.
  IF NEW.role IS DISTINCT FROM OLD.role AND lower(NEW.role) != lower(OLD.role) THEN
    NEW.role := OLD.role;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_profiles_role_escalation ON public.profiles;
CREATE TRIGGER trg_prevent_profiles_role_escalation
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_profiles_role_escalation();

COMMENT ON FUNCTION public.prevent_profiles_role_escalation IS
  'Blocks non-service-role sessions from setting profiles.role to privileged values. RBAC uses app_metadata.role only.';
