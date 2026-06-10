/**
 * Zuri Connect Africa — Route Guard Configuration
 *
 * Defines protection levels for all app routes.
 * Used by ProtectedRoute component and AuthGate to enforce access control.
 *
 * Protection levels:
 *   'public'      — no auth required
 *   'auth'        — authenticated user required (any role)
 *   'stepup'      — requires fresh step-up auth (PIN at minimum)
 *   'admin'       — elevated role required + step-up auth
 *
 * stepUpFreshMs:  How recently step-up must have occurred (0 = always re-prompt)
 */

export const ELEVATED_ADMIN_ROLES = ['admin', 'auditor', 'fraud_analyst'];

export const ROUTE_PROTECTION = {
  // ── Public ────────────────────────────────────────────────────────────
  '/':             { level: 'auth' },
  '/home':         { level: 'auth' },

  // ── Standard auth ─────────────────────────────────────────────────────
  '/history':      { level: 'auth' },
  '/notifications':{ level: 'auth' },
  '/profile':      { level: 'auth' },
  '/network':      { level: 'auth' },
  '/platform':     { level: 'auth' },

  // ── Step-up required — financial flows ────────────────────────────────
  '/wallet':       { level: 'stepup', stepUpFreshMs: 10 * 60_000, reason: 'Wallet access requires recent verification' },
  '/schedules':    { level: 'stepup', stepUpFreshMs: 10 * 60_000, reason: 'Scheduled payments require verification' },

  // ── Step-up required — security sensitive ─────────────────────────────
  '/security':     { level: 'stepup', stepUpFreshMs: 0,            reason: 'Security settings require PIN verification' },

  // ── Admin only ────────────────────────────────────────────────────────
  '/audit':                  { level: 'admin',  stepUpFreshMs: 0, allowedRoles: ELEVATED_ADMIN_ROLES, reason: 'Audit access requires elevated access' },
  '/admin':                  { level: 'admin',  stepUpFreshMs: 0, allowedRoles: ELEVATED_ADMIN_ROLES, reason: 'Admin dashboard requires elevated access' },
  '/admin/soc':              { level: 'admin',  stepUpFreshMs: 0, allowedRoles: ELEVATED_ADMIN_ROLES, reason: 'Security ops center requires elevated access' },
  '/admin/reconciliation':   { level: 'admin',  stepUpFreshMs: 0, allowedRoles: ELEVATED_ADMIN_ROLES, reason: 'Reconciliation queue requires elevated access' },

  // ── AI assistant — auth only ───────────────────────────────────────────
  '/ai':           { level: 'auth' },
};

/**
 * Get the protection config for a given pathname.
 * Falls back to 'auth' for unknown routes (fail-secure).
 */
export function getRouteProtection(pathname) {
  // Exact match first
  if (ROUTE_PROTECTION[pathname]) return ROUTE_PROTECTION[pathname];

  // Prefix match for nested routes
  for (const [route, config] of Object.entries(ROUTE_PROTECTION)) {
    if (pathname.startsWith(route) && route !== '/') return config;
  }

  // Default: require auth (fail-secure — never default to public)
  return { level: 'auth' };
}

export function requiresStepUp(pathname) {
  const config = getRouteProtection(pathname);
  return config.level === 'stepup' || config.level === 'admin';
}

export function requiresAdmin(pathname) {
  return getRouteProtection(pathname).level === 'admin';
}
