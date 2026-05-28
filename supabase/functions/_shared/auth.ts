/**
 * Shared edge-function auth helpers.
 * Import via: import { requireAuth, requireAdminAuth, isAuthResult } from '../_shared/auth.ts';
 *
 * requireAuth    — validates the Bearer JWT; returns { userId, user } or a 401 Response
 * requireAdminAuth — same, but also enforces app_metadata.role ∈ { admin, auditor }
 * isAuthResult   — type-guard to distinguish AuthResult from Response
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const ADMIN_ROLES = new Set(['admin', 'auditor']);

export interface AuthResult {
  userId: string;
  user: {
    id: string;
    email?: string;
    phone?: string;
    app_metadata: Record<string, unknown>;
    user_metadata: Record<string, unknown>;
  };
}

function makeSupabase() {
  const url        = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(url, serviceKey);
}

export async function requireAuth(req: Request): Promise<AuthResult | Response> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return Response.json({ error: 'missing_authorization' }, { status: 401 });
  }

  const supabase = makeSupabase();
  const { data: userRes, error } = await supabase.auth.getUser(jwt);
  if (error || !userRes.user) {
    return Response.json({ error: 'invalid_token' }, { status: 401 });
  }

  return {
    userId: userRes.user.id,
    user: {
      id:            userRes.user.id,
      email:         userRes.user.email,
      phone:         userRes.user.phone ?? undefined,
      app_metadata:  (userRes.user.app_metadata  ?? {}) as Record<string, unknown>,
      user_metadata: (userRes.user.user_metadata ?? {}) as Record<string, unknown>,
    },
  };
}

export async function requireAdminAuth(req: Request): Promise<AuthResult | Response> {
  const result = await requireAuth(req);
  if (!isAuthResult(result)) return result;

  const role = String(result.user.app_metadata?.role ?? '').toLowerCase();
  if (!ADMIN_ROLES.has(role)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }

  return result;
}

export function isAuthResult(v: AuthResult | Response): v is AuthResult {
  return !(v instanceof Response);
}
