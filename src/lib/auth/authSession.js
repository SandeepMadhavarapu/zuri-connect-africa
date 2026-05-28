/**
 * Maps Supabase Auth users to the application user shape (RBAC + profile fields).
 */
export function mapSessionUser(user) {
  if (!user) return null;
  const meta = user.user_metadata || {};
  const app = user.app_metadata || {};
  // app_metadata is service-role-only — it cannot be modified by the client SDK.
  // user_metadata is user-writable; a meta.role fallback would let any user call
  // supabase.auth.updateUser({ data: { role: 'admin' } }) to escalate privileges.
  const role = (app.role || 'customer').toLowerCase();
  const full_name = meta.full_name || meta.name || meta.fullName || '';
  const phone = user.phone || meta.phone || '';
  return {
    id: user.id,
    email: user.email || (phone ? `${String(phone).replace(/\D/g, '')}@phone.local` : undefined),
    aud: user.aud,
    created_at: user.created_at,
    ...meta,
    phone,
    full_name,
    role,
  };
}

export async function getAccessToken(supabase) {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
