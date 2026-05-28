-- Allow authenticated users to read all profiles
-- for contact lookup in the Send money flow.
-- Without this policy, users can only see their own profile.

DROP POLICY IF EXISTS "profiles_contacts_read" ON public.profiles;

CREATE POLICY "profiles_contacts_read"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON POLICY "profiles_contacts_read" ON public.profiles IS
  'Allows authenticated users to read all profiles for contact lookup.';
