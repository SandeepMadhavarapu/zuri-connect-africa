/**
 * Zuri Connect Africa — Provider Directory Registry (model + seed)
 *
 * This module defines the schema and a small seed for the Provider Directory
 * Registry. It is intentionally a UI/data-model preview only — a real
 * production registry requires a Supabase table + RLS + an admin-managed
 * verification pipeline before any PayBill / Till number is shown as verified.
 *
 * Hard rules enforced by tests:
 *   1. Every entry MUST carry verification metadata.
 *   2. No real PayBill / Till numbers are shipped in this seed. The `paybill`
 *      and `till` fields stay `null` until a verified provider source is
 *      connected. The optional `accountReferenceFormat` shows the user the
 *      shape of the account reference that the verified entry would expect.
 *   3. Every entry exposes `reportWrongNumberEnabled` so the wrong-number
 *      affordance can be rendered consistently.
 *
 * Field reference:
 *   providerName             string  — human-readable provider name
 *   category                 string  — directory category
 *   paymentMethodType        enum    — 'paybill' | 'till' | 'send_money' | 'partner_api'
 *   accountReferenceLabel    string  — label shown to the user (e.g. "Meter number")
 *   accountReferenceFormat   string  — short hint about the expected reference shape
 *   paybill                  string  — VERIFIED PayBill number, or null until verified
 *   till                     string  — VERIFIED Till number, or null until verified
 *   verificationStatus       enum    — 'unverified_sample' | 'pending_review' | 'verified'
 *   lastVerifiedAt           ISO|null — last successful verification timestamp
 *   sourceRequired           bool    — true when a verified provider source must be attached
 *   productionStatus         enum    — 'requires_provider_source' | 'integration_required' | 'staging_ready'
 *   reportWrongNumberEnabled bool    — surfaces the "Report wrong number" affordance
 *   displayCode              string  — safe non-payment placeholder shown to users
 *                                      whenever the entry is NOT a verified production
 *                                      entry. Defaults to 'Pending verification'.
 *   notes                    string  — non-claim operational notes
 *
 * Display-safety rule:
 *   The numeric PayBill / Till value MUST NOT be rendered to the user unless
 *   `isVerifiedProductionEntry(entry)` returns true. The UI helper
 *   `getDirectoryDisplayCode(entry)` returns the safe display string (the
 *   numeric value only when verified, otherwise the placeholder) so callers
 *   cannot accidentally leak unverified numbers into JSX.
 */

export const PENDING_VERIFICATION_PLACEHOLDER = 'Pending verification';
export const PENDING_VERIFICATION_RENDER_LABEL = 'Provider number pending verification';
export const PRODUCTION_PAYMENT_HELPER_COPY =
  'Provider source and admin verification required before production payment.';

export const PROVIDER_DIRECTORY_CATEGORIES = Object.freeze([
  'KPLC Tokens',
  'Water Bills',
  'Internet Bills',
  'School Fees Directory',
  'DStv / GOtv',
  'SACCO Deposits',
  'Hospital Bills',
  'Merchant Till Directory',
]);

export const PAYMENT_METHOD_TYPES = Object.freeze([
  'paybill',
  'till',
  'send_money',
  'partner_api',
]);

export const VERIFICATION_STATUSES = Object.freeze([
  'unverified_sample',
  'pending_review',
  'verified',
]);

export const PRODUCTION_STATUSES = Object.freeze([
  'requires_provider_source',
  'integration_required',
  'staging_ready',
]);

/**
 * Seed entries — UI/data-model preview only.
 * Note: every entry sets paybill/till to null and verificationStatus to
 * 'unverified_sample'. No PayBill / Till numbers are populated here.
 */
export const PROVIDER_DIRECTORY_SEED = Object.freeze([
  {
    providerName: 'KPLC Prepaid Tokens (sample)',
    category: 'KPLC Tokens',
    paymentMethodType: 'paybill',
    accountReferenceLabel: 'Meter number',
    accountReferenceFormat: '11-digit meter number',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'Real KPLC PayBill must be sourced from KPLC. Not shipped in this build.',
  },
  {
    providerName: 'County Water Utility (sample)',
    category: 'Water Bills',
    paymentMethodType: 'paybill',
    accountReferenceLabel: 'Account number',
    accountReferenceFormat: 'Utility-issued account number',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'County utility PayBill differs per county and must be sourced from the utility.',
  },
  {
    providerName: 'ISP Home Internet (sample)',
    category: 'Internet Bills',
    paymentMethodType: 'paybill',
    accountReferenceLabel: 'Subscriber / account number',
    accountReferenceFormat: 'ISP-issued subscriber number',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'ISP PayBill numbers must be sourced from the ISP directly.',
  },
  {
    providerName: 'School Fees (sample)',
    category: 'School Fees Directory',
    paymentMethodType: 'paybill',
    accountReferenceLabel: 'Admission number',
    accountReferenceFormat: 'School-issued admission number',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'Each school has a distinct PayBill that must be verified with the school office.',
  },
  {
    providerName: 'DStv / GOtv (sample)',
    category: 'DStv / GOtv',
    paymentMethodType: 'paybill',
    accountReferenceLabel: 'Smartcard / IUC number',
    accountReferenceFormat: 'Provider-issued smartcard number',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'PayBill must be sourced from MultiChoice / DStv official channels.',
  },
  {
    providerName: 'SACCO Deposits (sample)',
    category: 'SACCO Deposits',
    paymentMethodType: 'paybill',
    accountReferenceLabel: 'Member number',
    accountReferenceFormat: 'SACCO-issued member number',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'Each SACCO has its own PayBill that must be verified with the SACCO.',
  },
  {
    providerName: 'Hospital Bills (sample)',
    category: 'Hospital Bills',
    paymentMethodType: 'paybill',
    accountReferenceLabel: 'Patient / invoice reference',
    accountReferenceFormat: 'Hospital-issued reference',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'Hospital PayBill numbers must be confirmed at the cashier desk.',
  },
  {
    providerName: 'Merchant Till (sample)',
    category: 'Merchant Till Directory',
    paymentMethodType: 'till',
    accountReferenceLabel: 'Till number',
    accountReferenceFormat: 'Numeric Till (Buy Goods) number',
    paybill: null,
    till: null,
    verificationStatus: 'unverified_sample',
    lastVerifiedAt: null,
    sourceRequired: true,
    productionStatus: 'requires_provider_source',
    reportWrongNumberEnabled: true,
    displayCode: PENDING_VERIFICATION_PLACEHOLDER,
    notes: 'Till numbers must be verified at the merchant counter before paying.',
  },
]);

/**
 * isVerifiedProductionEntry — single decision point for "is this entry safe
 * to render its numeric PayBill / Till to the user?".
 *
 * An entry is considered verified-production ONLY when ALL of the following
 * are true:
 *   - verificationStatus === 'verified'
 *   - sourceRequired === false (a verified source has been attached)
 *   - lastVerifiedAt is a non-empty timestamp
 *   - productionStatus !== 'requires_provider_source'
 *
 * Any other combination MUST render the safe placeholder.
 */
export function isVerifiedProductionEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.verificationStatus !== 'verified') return false;
  if (entry.sourceRequired === true) return false;
  if (!entry.lastVerifiedAt) return false;
  if (entry.productionStatus === 'requires_provider_source') return false;
  return true;
}

/**
 * getDirectoryDisplayCode — returns the string to render to the user for a
 * provider entry. Returns the numeric value ONLY when the entry is fully
 * verified-production; otherwise returns the safe placeholder render label.
 *
 * Callers MUST use this helper instead of reading `entry.paybill`,
 * `entry.till`, or `entry.shortcode` directly when rendering to JSX.
 */
export function getDirectoryDisplayCode(entry) {
  if (!isVerifiedProductionEntry(entry)) return PENDING_VERIFICATION_RENDER_LABEL;
  return entry.paybill || entry.till || entry.shortcode || PENDING_VERIFICATION_RENDER_LABEL;
}

/**
 * Returns the seed entries, optionally filtered by category.
 */
export function getProviderDirectoryEntries(category = 'all') {
  if (category === 'all') return PROVIDER_DIRECTORY_SEED;
  return PROVIDER_DIRECTORY_SEED.filter((e) => e.category === category);
}

/**
 * Validation helper — used by tests. Returns the list of entries that violate
 * the honesty contract (claim a number without verification metadata, or claim
 * verified status without a lastVerifiedAt timestamp).
 */
export function findUnverifiedNumberClaims(entries = PROVIDER_DIRECTORY_SEED) {
  const offenders = [];
  for (const e of entries) {
    const hasNumber = e.paybill != null || e.till != null;
    if (hasNumber && e.verificationStatus !== 'verified') {
      offenders.push({ entry: e, reason: 'number_set_without_verified_status' });
    }
    if (e.verificationStatus === 'verified' && !e.lastVerifiedAt) {
      offenders.push({ entry: e, reason: 'verified_without_lastVerifiedAt' });
    }
    const requiredFields = [
      'verificationStatus',
      'lastVerifiedAt',
      'sourceRequired',
      'productionStatus',
      'reportWrongNumberEnabled',
    ];
    for (const f of requiredFields) {
      if (!(f in e)) {
        offenders.push({ entry: e, reason: `missing_field:${f}` });
      }
    }
  }
  return offenders;
}
