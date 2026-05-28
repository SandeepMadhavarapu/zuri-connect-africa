/**
 * Zuri Connect Africa — Role-Based Access Control (RBAC)
 * Governs what each role can see and do within the platform.
 *
 * Roles (least → most privileged):
 *   customer → support → fraud_analyst → auditor → admin
 */

export const ROLES = {
  CUSTOMER:      'customer',
  SUPPORT:       'support',
  FRAUD_ANALYST: 'fraud_analyst',
  AUDITOR:       'auditor',
  ADMIN:         'admin',
};

export const PERMISSIONS = {
  // Transaction permissions
  VIEW_OWN_TRANSACTIONS:     'view_own_transactions',
  VIEW_ALL_TRANSACTIONS:     'view_all_transactions',
  INITIATE_PAYMENT:          'initiate_payment',
  REVERSE_TRANSACTION:       'reverse_transaction',
  APPROVE_HIGH_RISK_PAYMENT: 'approve_high_risk_payment',

  // Fraud & security
  VIEW_FRAUD_FEED:           'view_fraud_feed',
  FLAG_TRANSACTION:          'flag_transaction',
  VIEW_DEVICE_REGISTRY:      'view_device_registry',
  MANAGE_TRUSTED_DEVICES:    'manage_trusted_devices',

  // Audit & compliance
  VIEW_AUDIT_LOG:            'view_audit_log',
  EXPORT_AUDIT_LOG:          'export_audit_log',
  RUN_RECONCILIATION:        'run_reconciliation',
  VIEW_LEDGER:               'view_ledger',

  // Admin
  MANAGE_USERS:              'manage_users',
  CONFIGURE_SYSTEM:          'configure_system',
};

// ── Permission map ─────────────────────────────────────────────────────────────

const ROLE_PERMISSIONS = {
  [ROLES.CUSTOMER]: new Set([
    PERMISSIONS.VIEW_OWN_TRANSACTIONS,
    PERMISSIONS.INITIATE_PAYMENT,
  ]),

  [ROLES.SUPPORT]: new Set([
    PERMISSIONS.VIEW_OWN_TRANSACTIONS,
    PERMISSIONS.VIEW_ALL_TRANSACTIONS,
    PERMISSIONS.INITIATE_PAYMENT,
    PERMISSIONS.FLAG_TRANSACTION,
    PERMISSIONS.VIEW_DEVICE_REGISTRY,
  ]),

  [ROLES.FRAUD_ANALYST]: new Set([
    PERMISSIONS.VIEW_OWN_TRANSACTIONS,
    PERMISSIONS.VIEW_ALL_TRANSACTIONS,
    PERMISSIONS.VIEW_FRAUD_FEED,
    PERMISSIONS.FLAG_TRANSACTION,
    PERMISSIONS.VIEW_DEVICE_REGISTRY,
    PERMISSIONS.MANAGE_TRUSTED_DEVICES,
  ]),

  [ROLES.AUDITOR]: new Set([
    PERMISSIONS.VIEW_OWN_TRANSACTIONS,
    PERMISSIONS.VIEW_ALL_TRANSACTIONS,
    PERMISSIONS.VIEW_FRAUD_FEED,
    PERMISSIONS.VIEW_AUDIT_LOG,
    PERMISSIONS.EXPORT_AUDIT_LOG,
    PERMISSIONS.VIEW_LEDGER,
    PERMISSIONS.VIEW_DEVICE_REGISTRY,
  ]),

  [ROLES.ADMIN]: new Set(Object.values(PERMISSIONS)),
};

// ── Role resolution ───────────────────────────────────────────────────────────

/**
 * Derive the effective role from a user object.
 * Supports `user.role` from Supabase user_metadata, falls back to 'customer'.
 */
export function getUserRole(user) {
  if (!user) return ROLES.CUSTOMER;

  const role = (user.role || '').toLowerCase().replace(/[^a-z_]/g, '');

  if (Object.values(ROLES).includes(role)) return role;

  // Map generic admin alias
  if (role === 'admin') return ROLES.ADMIN;

  return ROLES.CUSTOMER;
}

// ── Core permission check ─────────────────────────────────────────────────────

/**
 * Check if a user has a specific permission.
 * @param {object} user       — application user object (must have .role)
 * @param {string} permission — PERMISSIONS.*
 * @returns {boolean}
 */
export function hasPermission(user, permission) {
  const role  = getUserRole(user);
  const perms = ROLE_PERMISSIONS[role];
  return perms ? perms.has(permission) : false;
}

/**
 * Return all permissions for a user.
 */
export function getPermissions(user) {
  const role  = getUserRole(user);
  const perms = ROLE_PERMISSIONS[role];
  return perms ? Array.from(perms) : [];
}

// ── Domain-specific guards ────────────────────────────────────────────────────

/** Can the user access the fraud / risk dashboard? */
export function canViewFraudDashboard(user) {
  return hasPermission(user, PERMISSIONS.VIEW_FRAUD_FEED);
}

/** Can the user initiate a transaction reversal? */
export function canReverseTransactions(user) {
  return hasPermission(user, PERMISSIONS.REVERSE_TRANSACTION);
}

/** Can the user approve or override high-risk payment requests? */
export function canApproveHighRiskPayments(user) {
  return hasPermission(user, PERMISSIONS.APPROVE_HIGH_RISK_PAYMENT);
}

/** Can the user access the immutable audit log? */
export function canViewAuditLog(user) {
  return hasPermission(user, PERMISSIONS.VIEW_AUDIT_LOG);
}

/** Can the user trigger a ledger reconciliation run? */
export function canRunReconciliation(user) {
  return hasPermission(user, PERMISSIONS.RUN_RECONCILIATION);
}

/** Can the user manage (register/revoke) trusted devices? */
export function canManageTrustedDevices(user) {
  return hasPermission(user, PERMISSIONS.MANAGE_TRUSTED_DEVICES);
}

/** Can the user view all transactions across all accounts? */
export function canViewAllTransactions(user) {
  return hasPermission(user, PERMISSIONS.VIEW_ALL_TRANSACTIONS);
}

/** Can the user configure system-level settings? */
export function isAdmin(user) {
  return getUserRole(user) === ROLES.ADMIN;
}

/**
 * Enforce a permission check — throws a descriptive error if denied.
 * Use in critical paths (reversal, reconciliation, etc.).
 */
export function enforce(user, permission, context = '') {
  if (!hasPermission(user, permission)) {
    const role = getUserRole(user);
    const msg  = `[RBAC] Access denied — role "${role}" lacks "${permission}"${context ? ` (${context})` : ''}`;
    console.warn(msg);
    throw new Error(msg);
  }
}