-- Strips the `role` key from user_metadata at signup time.
--
-- WHY: Supabase allows clients to pass arbitrary user_metadata during signUp().
-- Before the authSession.js fix, meta.role was used as a role fallback, which
-- meant a caller could do:
--   supabase.auth.signUp({ ..., options: { data: { role: 'admin' } } })
-- to receive admin privileges immediately.
--
-- This trigger removes the attack surface entirely: even if meta.role is supplied,
-- it is stripped before the row is written to auth.users.
--
-- REGISTRATION in Supabase dashboard:
--   Authentication → Hooks → Before user sign up → select this function.
--   (Or leave as a direct trigger on auth.users INSERT — both work.)

CREATE OR REPLACE FUNCTION public.sanitize_signup_user_metadata()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Remove the `role` key so users cannot self-assign roles at signup.
  IF NEW.raw_user_meta_data ? 'role' THEN
    NEW.raw_user_meta_data = NEW.raw_user_meta_data - 'role';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger runs BEFORE every INSERT on auth.users (new account creation).
DROP TRIGGER IF EXISTS trg_sanitize_signup_user_metadata ON auth.users;
CREATE TRIGGER trg_sanitize_signup_user_metadata
  BEFORE INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sanitize_signup_user_metadata();

COMMENT ON FUNCTION public.sanitize_signup_user_metadata IS
  'Removes role from raw_user_meta_data on signup. Defense-in-depth for authSession.js app_metadata-only role enforcement.';
