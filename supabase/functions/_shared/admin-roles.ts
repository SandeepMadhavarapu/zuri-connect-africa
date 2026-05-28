/**
 * Zuri Connect Africa — server-side admin RBAC helper.
 *
 * Trust boundary: the user's role is read EXCLUSIVELY from
 * `auth.users.app_metadata.role` (or the JWT mirror returned by
 * `supabase.auth.getUser`). `user_metadata` is user-writable and MUST never
 * be consulted for privilege decisions.
 *
 * The helper is shared by every admin / reconciliation Edge Function so the
 * privilege model lives in one place and is auditable.
 */

// deno-lint-ignore-file no-explicit-any

export const ADMIN_ROLES = Object.freeze({
  ADMIN:         'admin',
  AUDITOR:       'auditor',
  FRAUD_ANALYST: 'fraud_analyst',
  SUPPORT:       'support',
});

export type AdminRole = (typeof ADMIN_ROLES)[keyof typeof ADMIN_ROLES];

export type AdminAuthResult =
  | {
      ok: true;
      user: { id: string; email?: string | null; phone?: string | null };
      role: AdminRole;
    }
  | {
      ok: false;
      status: 401 | 403;
      error: 'missing_authorization' | 'invalid_token' | 'forbidden';
    };

function extractRole(user: any): string {
  // ALWAYS read from app_metadata. Never from user_metadata.
  const meta = user?.app_metadata ?? {};
  const raw  = String(meta.role ?? '').toLowerCase().replace(/[^a-z_]/g, '');
  return raw;
}

function isAllowedRole(role: string, allowed: AdminRole[]): boolean {
  return (allowed as string[]).includes(role);
}

/**
 * Authenticate the caller and verify their admin role.
 *
 *   const auth = await requireAdminRole(supabaseAdmin, req, ['admin', 'auditor']);
 *   if (!auth.ok) return jsonError(auth.status, auth.error);
 */
export async function requireAdminRole(
  supabaseAdmin: any,
  req: Request,
  allowedRoles: AdminRole[],
): Promise<AdminAuthResult> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return { ok: false, status: 401, error: 'missing_authorization' };

  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error || !data?.user) return { ok: false, status: 401, error: 'invalid_token' };

  const role = extractRole(data.user);
  if (!isAllowedRole(role, allowedRoles)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }

  return {
    ok: true,
    user: {
      id:    data.user.id,
      email: data.user.email ?? null,
      phone: data.user.phone ?? null,
    },
    role: role as AdminRole,
  };
}

/**
 * True when the role is allowed to view the reconciliation queue. Auditor +
 * fraud_analyst + admin are read-eligible.
 */
export function canViewReconciliationQueue(role: AdminRole): boolean {
  return [ADMIN_ROLES.ADMIN, ADMIN_ROLES.AUDITOR, ADMIN_ROLES.FRAUD_ANALYST].includes(role);
}

/**
 * True when the role can mutate reconciliation state (mark resolved, escalate,
 * acknowledge timeout, reject orphan). Auditor is intentionally NOT included —
 * auditors are read-only.
 */
export function canMutateReconciliationQueue(role: AdminRole): boolean {
  return [ADMIN_ROLES.ADMIN, ADMIN_ROLES.FRAUD_ANALYST].includes(role);
}

/**
 * Admin-only actions (e.g. provider retry, reject orphan). Fraud analysts can
 * escalate and mark resolved but cannot trigger provider queries or reject
 * orphan callbacks (those border on payment lifecycle decisions).
 */
export function canRunAdminOnlyAction(role: AdminRole): boolean {
  return role === ADMIN_ROLES.ADMIN;
}
