/**
 * Zuri Connect Africa — Platform Readiness Source of Truth
 *
 * This module is the single, honest description of the platform components
 * Safaricom / M-PESA engineers should see when they evaluate the architecture
 * behind the app. It powers the /platform page and the platform-readiness
 * regression tests.
 *
 * Honesty rules enforced here (and asserted by tests):
 *   1. No component is ever marked `production_ready` in this build.
 *      We use the four honest statuses below:
 *        - implemented         : Code/migration/edge-function exists and ships
 *                                in this repo. Functional in staging conditions.
 *        - staging_ready       : Wired end-to-end but requires Safaricom / partner
 *                                onboarding (Daraja keys, signing secrets, etc.)
 *                                before it can transact.
 *        - integration_required: Model and contracts exist; the actual provider
 *                                or partner integration is the missing piece.
 *        - preview             : UI/data model preview only — backend wiring is
 *                                not yet present in this build.
 *
 *   2. Every `implemented` entry must point to at least one `proof` file inside
 *      the repository so the claim can be verified by a reviewer.
 *
 *   3. The page that renders these components labels itself "Architecture and
 *      rollout readiness — operational workflow preview", never "production".
 */

export const READINESS_STATUS = Object.freeze({
  IMPLEMENTED:           'implemented',
  STAGING_READY:         'staging_ready',
  INTEGRATION_REQUIRED:  'integration_required',
  PREVIEW:               'preview',
});

/** Label + tailwind class for each status pill. */
export const READINESS_STATUS_META = Object.freeze({
  implemented: {
    label: 'Implemented',
    className: 'bg-primary/10 text-primary border-primary/20',
    helper: 'Code, migration, or Edge Function ships in this repo.',
  },
  staging_ready: {
    label: 'Staging-ready',
    className: 'bg-blue-400/10 text-blue-400 border-blue-400/20',
    helper: 'Wired end-to-end · partner credentials / onboarding required to transact.',
  },
  integration_required: {
    label: 'Integration-required',
    className: 'bg-violet-400/10 text-violet-400 border-violet-400/20',
    helper: 'Contract is defined · official provider integration is the missing piece.',
  },
  preview: {
    label: 'Preview',
    className: 'bg-amber-400/10 text-amber-500 border-amber-400/20',
    helper: 'UI/data-model preview · backend wiring is not yet present in this build.',
  },
});

/**
 * The architecture components. Order is meaningful for the page render so we
 * present the user-facing surface first, then the platform substrate, then the
 * operational/ops layers.
 */
export const PLATFORM_COMPONENTS = Object.freeze([
  {
    id: 'client_app',
    name: 'Client app',
    layer: 'Client',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Vite + React 18 PWA shell with offline draft queue, render-guards, and route-level step-up enforcement.',
    proof: [
      'src/App.jsx',
      'src/components/layout/AppShell.jsx',
      'src/components/security/RouteGuard.jsx',
    ],
  },
  {
    id: 'supabase_auth',
    name: 'Supabase Auth',
    layer: 'Identity',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Phone-OTP + email/password auth with server-issued JWTs, role escalation prevention, and signup metadata sanitisation.',
    proof: [
      'src/lib/AuthContext.jsx',
      'supabase/migrations/20260517000003_sanitize_signup_metadata.sql',
      'supabase/migrations/20260517000004_prevent_profiles_role_escalation.sql',
    ],
  },
  {
    id: 'edge_functions',
    name: 'Edge Functions',
    layer: 'Platform',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Deno Edge Functions handle every sensitive action — payments, OTP, PIN, biometric, AI routing, reconciliation, devices.',
    proof: [
      'supabase/functions/initiate-payment/index.ts',
      'supabase/functions/complete-step-up/index.ts',
      'supabase/functions/webhook-handler/index.ts',
      'supabase/functions/admin-reconciliation/index.ts',
    ],
  },
  {
    id: 'daraja_stk_lifecycle',
    name: 'Daraja / STK Push lifecycle',
    layer: 'Payments',
    status: READINESS_STATUS.STAGING_READY,
    description:
      'STK lifecycle (initiate → callback → query → reconcile) is modelled server-side. Requires Safaricom Daraja consumer key / passkey / shortcode to transact.',
    proof: [
      'supabase/functions/initiate-payment/index.ts',
      'supabase/migrations/20260518140000_mpesa_payment_lifecycle_hardening.sql',
      'src/services/paymentService.js',
    ],
  },
  {
    id: 'webhook_handler',
    name: 'Webhook handler',
    layer: 'Payments',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Server-side webhook receiver with signature verification, nonce replay protection, and raw-payload isolation from the browser.',
    proof: [
      'supabase/functions/webhook-handler/index.ts',
      'supabase/migrations/20260511140000_webhook_nonces.sql',
      'supabase/functions/_shared/webhook-verify.ts',
    ],
  },
  {
    id: 'risk_engine',
    name: 'Risk engine',
    layer: 'Trust & Safety',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Server-authoritative risk decisions: velocity, scam-pattern, recipient-graph, device-trust signals decide step-up vs. block.',
    proof: [
      'supabase/migrations/20260518150000_server_side_risk_decisions.sql',
      'src/lib/riskEngine.js',
      'src/lib/scamShield.js',
    ],
  },
  {
    id: 'step_up_verification',
    name: 'Step-up verification',
    layer: 'Trust & Safety',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Adaptive step-up: PIN, OTP, or WebAuthn biometric. Challenge IDs are server-bound and single-use; biometric attestations are server-verified.',
    proof: [
      'supabase/functions/complete-step-up/index.ts',
      'supabase/migrations/20260520150000_webauthn_step_up_binding.sql',
      'src/lib/biometricStepUp.js',
    ],
  },
  {
    id: 'ledger_rpc',
    name: 'Ledger RPC',
    layer: 'Ledger',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Atomic double-entry RPC with optimistic balance locks. The client never writes balances — only RPC entrypoints do.',
    proof: [
      'supabase/migrations/20260512000000_atomic_double_entry.sql',
      'supabase/migrations/20260512000200_optimistic_balance_lock.sql',
      'supabase/migrations/20260518090000_server_authoritative_ledger.sql',
      'src/lib/ledgerRpc.js',
    ],
  },
  {
    id: 'hash_chain_ledger',
    name: 'Hash-chain ledger',
    layer: 'Ledger',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Append-only ledger accounts with per-row hash chaining and concurrency hardening — tamper-evident audit baseline.',
    proof: [
      'supabase/migrations/20260519100000_ledger_accounts_and_hash_chain.sql',
      'supabase/migrations/20260519110000_ledger_concurrency_hardening.sql',
      'src/components/audit/HashVerifier.jsx',
    ],
  },
  {
    id: 'reconciliation_job',
    name: 'Reconciliation job',
    layer: 'Operations',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Scheduled reconciliation Edge Function plus a reconciliation review view that surfaces orphan callbacks, mismatches, duplicates, and stuck timeouts.',
    proof: [
      'supabase/functions/reconciliation-job/index.ts',
      'supabase/migrations/20260511170000_reconciliation_engine.sql',
      'supabase/migrations/20260519040000_payment_reconciliation_review.sql',
    ],
  },
  {
    id: 'admin_review',
    name: 'Admin review',
    layer: 'Operations',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Admin / auditor / fraud-analyst console queues manual review, escalation, retry, and orphan-callback rejection — all via the admin-reconciliation Edge Function.',
    proof: [
      'supabase/functions/admin-reconciliation/index.ts',
      'src/pages/admin/ReconciliationCommandCenter.jsx',
      'src/lib/admin/reconciliationApi.js',
    ],
  },
  {
    id: 'duke_ai_router',
    name: 'Duke AI router',
    layer: 'Intelligence',
    status: READINESS_STATUS.STAGING_READY,
    description:
      'Server-side AI router with provider abstraction, per-user rate limits, and policy gates. Requires upstream provider keys on deployment.',
    proof: [
      'supabase/functions/ai-router/index.ts',
      'src/services/aiService.js',
    ],
  },
  {
    id: 'notification_dispatcher',
    name: 'Notification dispatcher',
    layer: 'Operations',
    status: READINESS_STATUS.STAGING_READY,
    description:
      'Server-side dispatcher for SMS / push / email events. Channel providers (Africa\u2019s Talking, FCM, transactional email) plug in on deployment.',
    proof: [
      'supabase/functions/notification-dispatcher/index.ts',
    ],
  },
  {
    id: 'provider_directory_registry',
    name: 'Provider directory registry',
    layer: 'Directory',
    status: READINESS_STATUS.INTEGRATION_REQUIRED,
    description:
      'Provider directory model with verification metadata (sourceRequired, verificationStatus, lastVerifiedAt, reportWrongNumberEnabled). No PayBill / Till numbers are populated until a verified provider source is connected.',
    proof: [
      'src/lib/providerDirectory.js',
    ],
  },
  {
    id: 'offline_step_up_queue',
    name: 'Offline draft / step-up queue',
    layer: 'Client',
    status: READINESS_STATUS.IMPLEMENTED,
    description:
      'Durable offline queue that holds drafts and step-up resume payloads; financial-priority drafts only sync after the user explicitly re-authorises.',
    proof: [
      'src/lib/offlineQueue.js',
      'src/lib/network/connectivityHook.js',
      'src/lib/durableEventBus.js',
    ],
  },
]);

export const READINESS_LAYERS = Object.freeze([
  'Client',
  'Identity',
  'Platform',
  'Payments',
  'Trust & Safety',
  'Ledger',
  'Operations',
  'Intelligence',
  'Directory',
]);

/** Group components by their logical layer for rendering. */
export function groupByLayer(components = PLATFORM_COMPONENTS) {
  const map = new Map();
  for (const layer of READINESS_LAYERS) map.set(layer, []);
  for (const c of components) {
    if (!map.has(c.layer)) map.set(c.layer, []);
    map.get(c.layer).push(c);
  }
  return Array.from(map.entries())
    .filter(([, items]) => items.length > 0)
    .map(([layer, items]) => ({ layer, items }));
}

/**
 * The four operational workflow previews surfaced on the platform page.
 * Each one is explicitly labelled to avoid implying live capability.
 */
export const OPERATIONAL_PREVIEWS = Object.freeze([
  {
    id: 'provider_verification',
    title: 'Provider verification readiness',
    label: 'Operational workflow preview',
    summary:
      'Steps required before a PayBill / Till entry can appear as verified in the directory.',
    bullets: [
      'Report wrong provider number — UI affordance available on directory entries.',
      'Verified provider source required — no number is shown as verified without one.',
      'Last verification status visible on every entry.',
      'Admin review needed before promoting an entry from unverified_sample to verified.',
      'Production registry required — backend table + RLS pending.',
    ],
  },
  {
    id: 'dispute_reversal',
    title: 'Dispute / reversal readiness',
    label: 'Reversal readiness flow',
    summary:
      'Operational shape of the dispute and reversal workflow. Reversals are NOT live in this build.',
    bullets: [
      'Report wrong payment from transaction history.',
      'Request reversal — opens a case, never moves money directly.',
      'Admin review queue (reuses the reconciliation review surface).',
      'Reconciliation link — case is tied to the underlying ledger entry.',
      'Case status — pending, under_review, resolved, declined.',
      'Evidence / receipt reference attached to each case.',
    ],
  },
  {
    id: 'merchant_business',
    title: 'Merchant / business readiness',
    label: 'Merchant Business preview',
    summary:
      'Operational shape of the Lipa-na-style merchant surface. Integration required before any collection or payroll runs.',
    bullets: [
      'Till collections — daily collection summary view.',
      'Statements — exportable merchant statement model.',
      'Staff roles — owner, cashier, accountant role separation.',
      'Approvals — two-step approval for high-value disbursements.',
      'Settlement status — pending / settled / on-hold visibility.',
      'Bulk / payroll readiness — file-driven disbursement model (integration-required).',
    ],
  },
]);

/**
 * Honesty assertion helper — used by tests. Returns the list of components
 * that violate the "no production_ready" rule (should always be empty).
 */
export function findOverclaimingComponents(components = PLATFORM_COMPONENTS) {
  const ALLOWED = new Set(Object.values(READINESS_STATUS));
  return components.filter((c) => !ALLOWED.has(c.status));
}
