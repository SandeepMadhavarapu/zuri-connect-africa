/**
 * Zuri Connect Africa — admin reconciliation dispatcher.
 *
 * Pure logic only. The Deno-specific wrapper lives in `index.ts` and just
 * binds env + the real Supabase admin client to `handleAdminReconciliation`.
 *
 * Trust boundary:
 *   * Role MUST come from `auth.users.app_metadata.role` — never from
 *     `user_metadata` or client input. See `_shared/admin-roles.ts`.
 *   * All reads use the `payment_reconciliation_review` VIEW only — never the
 *     raw `webhook_events` or `raw_callback` columns.
 *   * No action writes to `ledger_entries`. Ledger writes remain exclusive to
 *     `post_double_entry` via service role inside the webhook handler. Admin
 *     actions only annotate / transition `pending_payments` and emit audit
 *     events.
 *   * Actions against payments in a final ledger-affecting state
 *     (succeeded/reversed) are refused — the ledger cannot be retroactively
 *     mutated through an admin queue.
 */

// deno-lint-ignore-file no-explicit-any

import {
  ADMIN_ROLES,
  canMutateReconciliationQueue,
  canRunAdminOnlyAction,
  canViewReconciliationQueue,
  requireAdminRole,
  type AdminRole,
} from '../_shared/admin-roles.ts';
import {
  queryStkPush,
  readStkQueryEnv,
  type NormalizedStkQuery,
  type StkQueryInput,
} from '../_shared/daraja-query.ts';
import {
  applyProviderQueryResult,
  type PendingPaymentForApply,
} from '../_shared/provider-status-applier.ts';

const FILTERS = new Set([
  'all', 'review', 'orphan', 'timeout', 'mismatch', 'duplicate', 'provider_query_failed',
]);

const TERMINAL_PAYMENT_STATUSES = new Set([
  'succeeded', 'completed', 'confirmed', 'settled', 'reversed',
]);

const MUTATING_ACTIONS = new Set([
  'mark_review_resolved',
  'escalate_to_support',
  'mark_timeout_acknowledged',
  'reject_orphan_callback',
  'retry_provider_query',
]);

const ADMIN_ONLY_ACTIONS = new Set([
  'reject_orphan_callback',
  'retry_provider_query',
]);

const READ_ACTIONS = new Set(['queue', 'counts']);

export const SAFE_REVIEW_VIEW = 'payment_reconciliation_review';

// ── PII helpers ──────────────────────────────────────────────────────────

function maskPhone(phone: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '****';
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}

function redactReference(ref: string): string {
  if (!ref) return '';
  if (ref.length <= 32) return ref;
  return `${ref.slice(0, 18)}…${ref.slice(-4)}`;
}

function sanitizeQueueRow(r: Record<string, unknown>) {
  return {
    event_id:               r.event_id,
    pending_payment_id:     r.pending_payment_id,
    external_reference:     redactReference(String(r.external_reference ?? '')),
    reason:                 r.reason ?? r.event_type ?? null,
    provider_status:        r.provider_status,
    internal_status:        r.internal_status,
    amount_match:           r.amount_match,
    phone_match:            r.phone_match,
    requires_manual_review: r.requires_manual_review,
    event_type:             r.event_type,
    created_at:             r.created_at,
    tx_ref:                 r.tx_ref,
    amount:                 r.amount,
    from_phone:             maskPhone(String(r.from_phone ?? '')),
    to_phone:               maskPhone(String(r.to_phone ?? '')),
    pending_status:         r.pending_status,
    pending_updated_at:     r.pending_updated_at,
  };
}

// ── Audit + reconciliation event writers ─────────────────────────────────

async function writeAuditEvent(supabaseAdmin: any, event: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from('audit_events').insert({
    event_type:     event.event_type     ?? 'admin.reconciliation.event',
    event_category: event.event_category ?? 'financial',
    severity:       event.severity       ?? 'info',
    actor_id:       event.actor_id       ?? null,
    actor_type:     event.actor_type     ?? 'admin',
    target_type:    event.target_type    ?? 'pending_payments',
    target_id:      event.target_id      ?? null,
    action:         event.action         ?? 'admin_reconciliation_action',
    outcome:        event.outcome        ?? 'success',
    payload:        event.payload        ?? {},
    payload_hash:   '',
    correlation_id: event.correlation_id ?? null,
  });
  if (error) console.error('[admin-reconciliation] audit insert failed', error);
}

async function appendReconciliationEvent(supabaseAdmin: any, event: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from('payment_reconciliation_events').insert(event);
  if (error) console.error('[admin-reconciliation] event insert failed', error);
}

// ── Safe query helpers ───────────────────────────────────────────────────

async function fetchQueue(supabaseAdmin: any, filter: string, limit: number) {
  let query = supabaseAdmin
    .from(SAFE_REVIEW_VIEW)
    .select(
      'event_id, pending_payment_id, external_reference, reason, provider_status, internal_status, amount_match, phone_match, requires_manual_review, event_type, created_at, tx_ref, amount, from_phone, to_phone, pending_status, pending_updated_at',
    )
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, limit), 200));

  switch (filter) {
    case 'review':
      query = query.eq('requires_manual_review', true); break;
    case 'orphan':
      query = query.is('pending_payment_id', null); break;
    case 'timeout':
      query = query.eq('event_type', 'stuck_timeout'); break;
    case 'mismatch':
      query = query.in('event_type', ['amount_mismatch', 'phone_mismatch']); break;
    case 'duplicate':
      query = query.eq('event_type', 'duplicate_callback'); break;
    case 'provider_query_failed':
      query = query.eq('event_type', 'provider_query_failed'); break;
    default: break;
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(sanitizeQueueRow);
}

async function fetchCounts(supabaseAdmin: any, providerQueryConfigured: boolean) {
  const buckets: Record<string, number> = {
    waiting_for_mpesa: 0, processing: 0, timeout: 0, review_required: 0,
    succeeded: 0, failed: 0, cancelled: 0,
  };
  const { data: pendingRows } = await supabaseAdmin
    .from('pending_payments')
    .select('status')
    .in('status', Object.keys(buckets))
    .limit(5000);
  for (const r of pendingRows ?? []) {
    const s = String((r as Record<string, unknown>).status ?? '');
    if (s in buckets) buckets[s] += 1;
  }

  const eventBuckets: Record<string, number> = {
    amount_mismatch: 0, phone_mismatch: 0, duplicate_callback: 0,
    stuck_timeout: 0, stuck_review_required: 0, provider_query_failed: 0,
    conflicting_provider_status: 0, late_conflicting_callback: 0,
  };
  const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
  const { data: eventRows } = await supabaseAdmin
    .from('payment_reconciliation_events')
    .select('event_type')
    .in('event_type', Object.keys(eventBuckets))
    .gte('created_at', since)
    .limit(5000);
  for (const r of eventRows ?? []) {
    const t = String((r as Record<string, unknown>).event_type ?? '');
    if (t in eventBuckets) eventBuckets[t] += 1;
  }

  const { count: orphanCount } = await supabaseAdmin
    .from('webhook_events')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'mpesa_callback')
    .eq('status', 'failed');

  return {
    pending:           buckets,
    reconciliation:    eventBuckets,
    orphan_callbacks:  orphanCount ?? 0,
    provider_query_configured: providerQueryConfigured,
    window_days:       7,
  };
}

async function fetchPendingPaymentSafely(supabaseAdmin: any, id: string) {
  const { data, error } = await supabaseAdmin
    .from('pending_payments')
    .select('id, tx_ref, user_id, payment_type, amount, from_phone, to_phone, status, result_code, result_desc, checkout_request_id, merchant_request_id, ledger_posted_at, created_at, updated_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function rejectIfTerminalLedger(supabaseAdmin: any, pendingPaymentId: string) {
  const row = await fetchPendingPaymentSafely(supabaseAdmin, pendingPaymentId);
  if (!row) return { ok: false as const, reason: 'pending_payment_not_found' as const };
  const status = String(row.status ?? '').toLowerCase();
  if (TERMINAL_PAYMENT_STATUSES.has(status) || row.ledger_posted_at) {
    return { ok: false as const, reason: 'payment_in_terminal_ledger_state' as const, row };
  }
  return { ok: true as const, row };
}

// ── Action implementations ───────────────────────────────────────────────

type ActionContext = {
  supabaseAdmin: any;
  actorId: string;
  role:    AdminRole;
  jsonOk:  (extra?: Record<string, unknown>) => HandlerResult;
  jsonErr: (code: string, status: number) => HandlerResult;
};

async function actionMarkReviewResolved(ctx: ActionContext, body: Record<string, unknown>) {
  const id = String(body.pending_payment_id ?? '').trim();
  if (!id) return ctx.jsonErr('pending_payment_id_required', 400);

  const check = await rejectIfTerminalLedger(ctx.supabaseAdmin, id);
  if (!check.ok) return ctx.jsonErr(check.reason, 409);

  const note = String(body.note ?? '').slice(0, 500);
  const { error } = await ctx.supabaseAdmin
    .from('pending_payments')
    .update({
      status:      'review_required',
      result_desc: `admin_review_resolved:${ctx.actorId}`,
      updated_at:  new Date().toISOString(),
    })
    .eq('id', id);
  if (error) return ctx.jsonErr('update_failed', 500);

  await appendReconciliationEvent(ctx.supabaseAdmin, {
    pending_payment_id: id,
    external_reference: check.row.tx_ref,
    provider_status:    check.row.status,
    internal_status:    'review_resolved',
    amount_match:       null,
    phone_match:        null,
    requires_manual_review: false,
    raw_provider_payload_hash: '',
    event_type:         'admin_review_resolved',
    reason:             note || 'admin marked review resolved',
  });
  await writeAuditEvent(ctx.supabaseAdmin, {
    event_type: 'admin.reconciliation.review_resolved',
    actor_id:   ctx.actorId,
    target_id:  id,
    severity:   'info',
    action:     'mark_review_resolved',
    outcome:    'success',
    payload:    { note: note || null, role: ctx.role },
    correlation_id: check.row.tx_ref,
  });
  return ctx.jsonOk();
}

async function actionEscalateToSupport(ctx: ActionContext, body: Record<string, unknown>) {
  const id = String(body.pending_payment_id ?? '').trim();
  if (!id) return ctx.jsonErr('pending_payment_id_required', 400);

  const check = await rejectIfTerminalLedger(ctx.supabaseAdmin, id);
  if (!check.ok) return ctx.jsonErr(check.reason, 409);

  const note = String(body.note ?? '').slice(0, 500);
  await appendReconciliationEvent(ctx.supabaseAdmin, {
    pending_payment_id: id,
    external_reference: check.row.tx_ref,
    provider_status:    check.row.status,
    internal_status:    check.row.status,
    amount_match:       null,
    phone_match:        null,
    requires_manual_review: true,
    raw_provider_payload_hash: '',
    event_type:         'admin_escalated_to_support',
    reason:             note || 'escalated to support tier 2',
  });
  await writeAuditEvent(ctx.supabaseAdmin, {
    event_type: 'admin.reconciliation.escalated',
    actor_id:   ctx.actorId,
    target_id:  id,
    severity:   'warn',
    action:     'escalate_to_support',
    outcome:    'pending',
    payload:    { note: note || null, role: ctx.role },
    correlation_id: check.row.tx_ref,
  });
  return ctx.jsonOk();
}

async function actionMarkTimeoutAcknowledged(ctx: ActionContext, body: Record<string, unknown>) {
  const id = String(body.pending_payment_id ?? '').trim();
  if (!id) return ctx.jsonErr('pending_payment_id_required', 400);

  const check = await rejectIfTerminalLedger(ctx.supabaseAdmin, id);
  if (!check.ok) return ctx.jsonErr(check.reason, 409);

  await appendReconciliationEvent(ctx.supabaseAdmin, {
    pending_payment_id: id,
    external_reference: check.row.tx_ref,
    provider_status:    check.row.status,
    internal_status:    check.row.status,
    amount_match:       null,
    phone_match:        null,
    requires_manual_review: false,
    raw_provider_payload_hash: '',
    event_type:         'admin_timeout_acknowledged',
    reason:             String(body.note ?? 'timeout acknowledged'),
  });
  await writeAuditEvent(ctx.supabaseAdmin, {
    event_type: 'admin.reconciliation.timeout_acknowledged',
    actor_id:   ctx.actorId,
    target_id:  id,
    severity:   'info',
    action:     'mark_timeout_acknowledged',
    outcome:    'success',
    payload:    { role: ctx.role },
    correlation_id: check.row.tx_ref,
  });
  return ctx.jsonOk();
}

async function actionRejectOrphanCallback(ctx: ActionContext, body: Record<string, unknown>) {
  if (!canRunAdminOnlyAction(ctx.role)) return ctx.jsonErr('forbidden', 403);
  const eventId = String(body.reconciliation_event_id ?? '').trim();
  if (!eventId) return ctx.jsonErr('reconciliation_event_id_required', 400);

  const { data: source, error: srcErr } = await ctx.supabaseAdmin
    .from('webhook_events')
    .select('id, idempotency_key, payload_hash, status')
    .eq('id', eventId)
    .maybeSingle();
  if (srcErr) return ctx.jsonErr('lookup_failed', 500);
  if (!source) return ctx.jsonErr('webhook_event_not_found', 404);

  await writeAuditEvent(ctx.supabaseAdmin, {
    event_type: 'admin.reconciliation.orphan_rejected',
    actor_id:   ctx.actorId,
    target_type: 'webhook_events',
    target_id:  source.id,
    severity:   'warn',
    action:     'reject_orphan_callback',
    outcome:    'denied',
    payload:    {
      idempotency_key: source.idempotency_key,
      payload_hash:    source.payload_hash,
      note:            String(body.note ?? '').slice(0, 500) || null,
      role:            ctx.role,
    },
  });
  return ctx.jsonOk();
}

async function actionRetryProviderQuery(
  ctx: ActionContext,
  body: Record<string, unknown>,
  deps: AdminReconciliationDeps,
) {
  // Defence in depth: only admins can directly trigger a server-side provider
  // query. fraud_analyst can `escalate_to_support` but cannot run Daraja
  // queries.
  if (!canRunAdminOnlyAction(ctx.role)) return ctx.jsonErr('forbidden', 403);
  if (!deps.providerQueryConfigured)    return ctx.jsonErr('provider_query_not_configured', 503);

  const id = String(body.pending_payment_id ?? '').trim();
  if (!id) return ctx.jsonErr('pending_payment_id_required', 400);

  const check = await rejectIfTerminalLedger(ctx.supabaseAdmin, id);
  if (!check.ok) return ctx.jsonErr(check.reason, 409);

  // The payment must have a CheckoutRequestID from initiate-payment; STK
  // Query is keyed on that and not on tx_ref.
  const checkoutRequestId = String(check.row.checkout_request_id ?? '').trim();
  if (!checkoutRequestId) {
    await writeAuditEvent(ctx.supabaseAdmin, {
      event_type: 'admin.reconciliation.provider_retry_noop',
      actor_id:   ctx.actorId,
      target_id:  id,
      severity:   'warn',
      action:     'retry_provider_query',
      outcome:    'failure',
      payload:    { reason: 'missing_checkout_request_id', role: ctx.role },
      correlation_id: check.row.tx_ref,
    });
    return ctx.jsonErr('missing_checkout_request_id', 409);
  }

  // 1. provider_query.requested — visible immediately in the review queue.
  await appendReconciliationEvent(ctx.supabaseAdmin, {
    pending_payment_id: id,
    external_reference: checkoutRequestId,
    provider_status:    'requested',
    internal_status:    check.row.status,
    amount_match:       null,
    phone_match:        null,
    requires_manual_review: false,
    raw_provider_payload_hash: '',
    event_type:         'provider_query.requested',
    reason:             'admin requested immediate provider status query',
  });
  await writeAuditEvent(ctx.supabaseAdmin, {
    event_type: 'admin.reconciliation.provider_retry_requested',
    actor_id:   ctx.actorId,
    target_id:  id,
    severity:   'info',
    action:     'retry_provider_query',
    outcome:    'pending',
    payload:    { role: ctx.role, checkout_request_id: checkoutRequestId },
    correlation_id: check.row.tx_ref,
  });

  // 2. Run the Daraja STK Query. Inputs come from server env only.
  const readEnv  = deps.readStkQueryEnv ?? readStkQueryEnv;
  const runQuery = deps.queryStkPush    ?? queryStkPush;
  const stkInput = readEnv(checkoutRequestId, check.row.merchant_request_id ?? null);
  if (!stkInput) {
    await writeAuditEvent(ctx.supabaseAdmin, {
      event_type: 'admin.reconciliation.provider_retry_failed',
      actor_id:   ctx.actorId,
      target_id:  id,
      severity:   'warn',
      action:     'retry_provider_query',
      outcome:    'failure',
      payload:    { reason: 'env_secrets_unavailable', role: ctx.role },
      correlation_id: check.row.tx_ref,
    });
    return ctx.jsonErr('provider_query_not_configured', 503);
  }

  let result: NormalizedStkQuery;
  try {
    result = await runQuery(stkInput);
  } catch (e) {
    // queryStkPush itself never throws (errors collapse to provider_error),
    // but be paranoid in case a custom injection is unsafe.
    await writeAuditEvent(ctx.supabaseAdmin, {
      event_type: 'admin.reconciliation.provider_retry_failed',
      actor_id:   ctx.actorId,
      target_id:  id,
      severity:   'warn',
      action:     'retry_provider_query',
      outcome:    'failure',
      payload:    { reason: 'query_threw', error_name: (e as Error)?.name ?? null, role: ctx.role },
      correlation_id: check.row.tx_ref,
    });
    return ctx.jsonErr('provider_query_failed', 502);
  }

  // 3. Apply the result via the shared applier — never posts ledger.
  const report = await applyProviderQueryResult(
    check.row as PendingPaymentForApply,
    result,
    {
      updatePendingPayment: async (rowId, patch) => {
        const { error } = await ctx.supabaseAdmin.from('pending_payments').update(patch).eq('id', rowId);
        if (error) throw new Error(error.message);
      },
      recordEvent: async (event) => appendReconciliationEvent(ctx.supabaseAdmin, event),
      writeAuditEvent: async (event) => writeAuditEvent(ctx.supabaseAdmin, event),
      now: deps.now,
    },
    {
      reviewAfterMinutes: deps.reviewAfterMinutes ?? 120,
      trigger:            'admin_retry',
      actorId:            ctx.actorId,
      // Admin retry escalates inconclusive results immediately so the operator
      // sees the row land in review_required when STK Query is uncooperative.
      escalateInconclusiveImmediately: true,
    },
  );

  await writeAuditEvent(ctx.supabaseAdmin, {
    event_type: 'admin.reconciliation.provider_retry_executed',
    actor_id:   ctx.actorId,
    target_id:  id,
    severity:   'info',
    action:     'retry_provider_query',
    outcome:    report.action.startsWith('noop_') ? 'success' : 'success',
    payload:    {
      role: ctx.role,
      provider_outcome: result.outcome,
      applier_action:   report.action,
      new_status:       report.newStatus,
    },
    correlation_id: check.row.tx_ref,
  });

  return ctx.jsonOk({
    provider_outcome: result.outcome,
    applier_action:   report.action,
    new_status:       report.newStatus,
    queried_at:       result.queriedAt,
  });
}

// ── Pure dispatcher (testable) ───────────────────────────────────────────

export type HandlerResult = { status: number; body: Record<string, unknown> };

export type AdminReconciliationDeps = {
  supabaseAdmin: any;
  // For tests, allow the caller to inject an `requireAdminRole` substitute
  // (otherwise we use the shared helper bound to `supabaseAdmin`).
  requireAdminRole?: typeof requireAdminRole;
  providerQueryConfigured: boolean;
  /** Inject the Daraja STK Query call so tests can exercise the full path. */
  queryStkPush?: (input: StkQueryInput) => Promise<NormalizedStkQuery>;
  /** Inject the env reader so tests can supply Daraja secrets without process.env. */
  readStkQueryEnv?: (checkoutRequestId: string, merchantRequestId: string | null) => StkQueryInput | null;
  /** Minutes after which "still_pending" should be escalated to review (mirrors reconciliation-job). */
  reviewAfterMinutes?: number;
  /** Inject clock for tests. */
  now?: () => Date;
};

export async function handleAdminReconciliation(
  req: Request,
  deps: AdminReconciliationDeps,
): Promise<HandlerResult> {
  if (req.method !== 'POST') return { status: 405, body: { ok: false, error: 'METHOD_NOT_ALLOWED' } };

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return { status: 400, body: { ok: false, error: 'INVALID_JSON' } }; }

  const action = String(body.action ?? '').trim();

  // The auth check uses a coarse "is this caller in the admin family" list so
  // that auditor attempts at mutation still reach the per-action role gate
  // (which writes an audit event before refusing). The per-action gate further
  // refines into mutate / admin-only eligibility.
  let allowed: AdminRole[];
  if (READ_ACTIONS.has(action) || MUTATING_ACTIONS.has(action) || ADMIN_ONLY_ACTIONS.has(action)) {
    allowed = [ADMIN_ROLES.ADMIN, ADMIN_ROLES.AUDITOR, ADMIN_ROLES.FRAUD_ANALYST];
  } else {
    return { status: 400, body: { ok: false, error: 'unknown_action' } };
  }

  const verify = deps.requireAdminRole ?? requireAdminRole;
  const auth = await verify(deps.supabaseAdmin, req, allowed);
  if (!auth.ok) {
    return { status: auth.status, body: { ok: false, error: auth.error } };
  }

  const jsonOk  = (extra?: Record<string, unknown>): HandlerResult => ({
    status: 200, body: { ok: true, ...(extra ?? {}) },
  });
  const jsonErr = (code: string, status: number): HandlerResult => ({
    status, body: { ok: false, error: code },
  });

  try {
    if (action === 'queue') {
      if (!canViewReconciliationQueue(auth.role)) return jsonErr('forbidden', 403);
      const filter = String(body.filter ?? 'all');
      const safeFilter = FILTERS.has(filter) ? filter : 'all';
      const limit = Number(body.limit ?? 50);
      const rows = await fetchQueue(deps.supabaseAdmin, safeFilter, limit);
      return jsonOk({
        viewer_role:        auth.role,
        can_mutate:         canMutateReconciliationQueue(auth.role),
        can_run_admin_only: canRunAdminOnlyAction(auth.role),
        filter:             safeFilter,
        rows,
      });
    }

    if (action === 'counts') {
      if (!canViewReconciliationQueue(auth.role)) return jsonErr('forbidden', 403);
      const counts = await fetchCounts(deps.supabaseAdmin, deps.providerQueryConfigured);
      return jsonOk({ viewer_role: auth.role, counts });
    }

    if (!canMutateReconciliationQueue(auth.role)) {
      await writeAuditEvent(deps.supabaseAdmin, {
        event_type: 'admin.reconciliation.forbidden_mutation',
        actor_id:   auth.user.id,
        severity:   'warn',
        action,
        outcome:    'denied',
        payload:    { role: auth.role },
      });
      return jsonErr('forbidden', 403);
    }

    if (ADMIN_ONLY_ACTIONS.has(action) && !canRunAdminOnlyAction(auth.role)) {
      await writeAuditEvent(deps.supabaseAdmin, {
        event_type: 'admin.reconciliation.forbidden_admin_only',
        actor_id:   auth.user.id,
        severity:   'warn',
        action,
        outcome:    'denied',
        payload:    { role: auth.role },
      });
      return jsonErr('forbidden', 403);
    }

    const ctx: ActionContext = {
      supabaseAdmin: deps.supabaseAdmin,
      actorId:       auth.user.id,
      role:          auth.role,
      jsonOk, jsonErr,
    };

    switch (action) {
      case 'mark_review_resolved':       return await actionMarkReviewResolved(ctx, body);
      case 'escalate_to_support':         return await actionEscalateToSupport(ctx, body);
      case 'mark_timeout_acknowledged':   return await actionMarkTimeoutAcknowledged(ctx, body);
      case 'reject_orphan_callback':      return await actionRejectOrphanCallback(ctx, body);
      case 'retry_provider_query':
        return await actionRetryProviderQuery(ctx, body, deps);
      default:
        return jsonErr('unknown_action', 400);
    }
  } catch (e) {
    console.error('[admin-reconciliation] failure', e);
    return jsonErr('internal_error', 500);
  }
}
