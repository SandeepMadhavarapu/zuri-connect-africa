/**
 * Zuri Connect Africa — provider-status applier.
 *
 * Given a normalised `NormalizedStkQuery` result and the matching
 * `pending_payments` row, this module decides which safe state transition to
 * apply WITHOUT ever writing to the ledger. It is intentionally a small set
 * of pure functions so the same logic runs from:
 *
 *   * `reconciliation-job` (cron / scheduled sweep)
 *   * `admin-reconciliation` `retry_provider_query` (manual operator action)
 *
 * Hard invariants enforced here:
 *
 *   1. STK Query is NEVER authoritative enough to post a ledger entry. It
 *      returns no amount / phone / receipt — we therefore route `succeeded`
 *      to `review_required` and let the real Daraja callback (or an admin
 *      with extra context) finalise.
 *   2. If `ledger_posted_at` is already set we touch nothing — the payment is
 *      already finalised; STK Query results only feed observability events.
 *   3. Provider errors / unknowns NEVER terminate the payment. They stay in
 *      `waiting_for_mpesa` until the review threshold elapses; only then do
 *      we escalate to `review_required`.
 *   4. Every decision writes EXACTLY one `payment_reconciliation_events` row
 *      and at most one `audit_events` row. Event names are canonical so
 *      observability + the safe view stay consistent.
 */

// deno-lint-ignore-file no-explicit-any

import type { NormalizedStkQuery, ProviderQueryOutcome } from './daraja-query.ts';

// ── Inputs / outputs ─────────────────────────────────────────────────────

export type PendingPaymentForApply = {
  id:                  string;
  tx_ref:              string;
  user_id?:            string | null;
  status:              string;
  amount:              number | string;
  from_phone:          string;
  to_phone:            string;
  checkout_request_id?: string | null;
  merchant_request_id?: string | null;
  updated_at?:         string | null;
  ledger_posted_at?:   string | null;
};

export type ProviderApplyDeps = {
  /** Updates pending_payments. Must reject ledger_posted_at transitions per the table trigger. */
  updatePendingPayment: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** Appends payment_reconciliation_events. */
  recordEvent: (event: Record<string, unknown>) => Promise<unknown>;
  /** Appends audit_events. */
  writeAuditEvent?: (event: Record<string, unknown>) => Promise<unknown>;
  /** Clock injection. */
  now?: () => Date;
};

export type ProviderApplyConfig = {
  /** Minutes past which an inconclusive provider result escalates to review. */
  reviewAfterMinutes: number;
  /** Trigger identifier — 'reconciliation_sweep' | 'admin_retry'. */
  trigger: 'reconciliation_sweep' | 'admin_retry';
  /** Identifier of the human (or 'system') initiating the action. */
  actorId?: string;
  /** When true (admin retry), an inconclusive result IMMEDIATELY escalates to
   *  review_required regardless of age. The sweep keeps the polite "wait for
   *  next callback" behaviour by leaving this false. */
  escalateInconclusiveImmediately?: boolean;
};

export type ProviderApplyReport = {
  action:
    | 'noop_already_terminal'
    | 'noop_ledger_posted'
    | 'noop_still_pending'
    | 'transitioned_failed'
    | 'transitioned_cancelled'
    | 'transitioned_timeout'
    | 'transitioned_review_required'
    | 'transitioned_amount_mismatch_review'
    | 'transitioned_phone_mismatch_review';
  newStatus: string | null;
  reason:    string;
};

const TERMINAL_LEDGER_STATUSES = new Set([
  'succeeded', 'completed', 'confirmed', 'settled', 'reversed',
]);
const TERMINAL_NON_LEDGER_STATUSES = new Set([
  'failed', 'cancelled', 'canceled', 'timeout', 'review_required',
]);
const STILL_OPEN_STATUSES = new Set(['waiting_for_mpesa', 'processing']);

// ── Public entry point ───────────────────────────────────────────────────

/**
 * Apply a normalised Daraja STK Query result to a pending_payments row.
 *
 * Returns a report describing the decision. Never throws on application
 * logic — only re-throws DB errors from the deps.
 */
export async function applyProviderQueryResult(
  pending: PendingPaymentForApply,
  query:    NormalizedStkQuery,
  deps:     ProviderApplyDeps,
  config:   ProviderApplyConfig,
): Promise<ProviderApplyReport> {
  const now = (deps.now ?? (() => new Date()))();
  const status = String(pending.status ?? '').toLowerCase();
  const baseEventPayload = {
    pending_payment_id:    pending.id,
    external_reference:    pending.checkout_request_id || pending.tx_ref,
    provider_status:       query.outcome,
    internal_status:       status,
    amount_match:          null as boolean | null,
    phone_match:           null as boolean | null,
    raw_provider_payload_hash: query.rawPayloadHash || '',
  };

  // ── Invariant 1: ledger already posted ⇒ never touch the row ───────────
  if (pending.ledger_posted_at) {
    await deps.recordEvent({
      ...baseEventPayload,
      requires_manual_review: query.outcome !== 'succeeded',
      event_type: 'provider_query.noop_terminal',
      reason:     `ledger already posted at ${pending.ledger_posted_at}; provider says ${query.outcome}`,
    });
    await deps.writeAuditEvent?.({
      event_type:     'reconciliation.provider_query.noop_ledger_posted',
      event_category: 'financial',
      severity:       query.outcome === 'succeeded' ? 'info' : 'critical',
      actor_id:       config.actorId ?? null,
      actor_type:     config.trigger === 'admin_retry' ? 'admin' : 'service',
      target_type:    'pending_payments',
      target_id:      pending.id,
      action:         'provider_query_noop_ledger_posted',
      outcome:        'success',
      payload:        { provider_outcome: query.outcome, trigger: config.trigger },
      correlation_id: pending.tx_ref,
    });
    return { action: 'noop_ledger_posted', newStatus: null, reason: 'ledger_already_posted' };
  }

  // ── Invariant 2: already terminal (failed/cancelled/timeout/review) ────
  if (TERMINAL_NON_LEDGER_STATUSES.has(status) || TERMINAL_LEDGER_STATUSES.has(status)) {
    await deps.recordEvent({
      ...baseEventPayload,
      requires_manual_review: query.outcome === 'succeeded',
      event_type: 'provider_query.noop_terminal',
      reason:     `payment already terminal: ${status}; provider says ${query.outcome}`,
    });
    if (query.outcome === 'succeeded') {
      // Late success after a terminal failure is a serious signal — escalate
      // for manual ops review but never auto-reverse.
      await deps.writeAuditEvent?.({
        event_type:     'reconciliation.provider_query.late_success_after_terminal',
        event_category: 'financial',
        severity:       'critical',
        actor_id:       config.actorId ?? null,
        actor_type:     config.trigger === 'admin_retry' ? 'admin' : 'service',
        target_type:    'pending_payments',
        target_id:      pending.id,
        action:         'flag_late_success_for_review',
        outcome:        'pending',
        payload:        { previous_status: status, trigger: config.trigger },
        correlation_id: pending.tx_ref,
      });
    }
    return { action: 'noop_already_terminal', newStatus: null, reason: `already_${status}` };
  }

  if (!STILL_OPEN_STATUSES.has(status)) {
    // Unknown status — refuse to act, just observe.
    await deps.recordEvent({
      ...baseEventPayload,
      requires_manual_review: true,
      event_type: 'provider_query.manual_review_required',
      reason:     `unknown internal status ${status}`,
    });
    return { action: 'noop_already_terminal', newStatus: null, reason: 'unknown_internal_status' };
  }

  // ── Apply per provider outcome ─────────────────────────────────────────
  switch (query.outcome) {
    case 'succeeded':
      return await applySucceeded(pending, query, deps, config, now, baseEventPayload);
    case 'failed':
      return await applyTransition(
        pending, query, deps, config, now, baseEventPayload,
        'failed', 'provider_query.failed', 'transitioned_failed',
      );
    case 'cancelled':
      return await applyTransition(
        pending, query, deps, config, now, baseEventPayload,
        'cancelled', 'provider_query.failed', 'transitioned_cancelled',
      );
    case 'timeout':
      return await applyTransition(
        pending, query, deps, config, now, baseEventPayload,
        'timeout', 'provider_query.failed', 'transitioned_timeout',
      );
    case 'still_pending':
      return await applyStillPending(pending, query, deps, config, now, baseEventPayload);
    case 'provider_unknown':
    case 'provider_error':
      return await applyProviderInconclusive(pending, query, deps, config, now, baseEventPayload);
    default: {
      // Exhaustiveness — TypeScript would flag this. Be safe at runtime too.
      const _exhaustive: never = query.outcome as never;
      void _exhaustive;
      return { action: 'noop_still_pending', newStatus: null, reason: 'unrecognised_outcome' };
    }
  }
}

// ── Branch helpers ───────────────────────────────────────────────────────

async function applySucceeded(
  pending: PendingPaymentForApply,
  query:    NormalizedStkQuery,
  deps:     ProviderApplyDeps,
  config:   ProviderApplyConfig,
  now:      Date,
  basePayload: Record<string, unknown>,
): Promise<ProviderApplyReport> {
  // STK Query has NO MpesaReceiptNumber / Amount / PhoneNumber — we therefore
  // CANNOT verify amount or phone here. Route to review_required so an admin
  // (or the eventual real callback) can finalise the ledger. We NEVER call
  // the ledger RPC from this code path.
  await deps.updatePendingPayment(pending.id, {
    status:                 'review_required',
    result_code:            query.resultCode || '0',
    result_desc:            `provider_query_succeeded:${query.resultDesc || 'OK'}`,
    callback_payload_hash:  query.rawPayloadHash,
    updated_at:             now.toISOString(),
  });
  await deps.recordEvent({
    ...basePayload,
    requires_manual_review: true,
    event_type: 'provider_query.succeeded',
    reason:     'provider reported success without receipt/amount/phone; awaiting verified callback or admin finalisation',
  });
  await deps.recordEvent({
    ...basePayload,
    requires_manual_review: true,
    event_type: 'provider_query.manual_review_required',
    reason:     'STK Query success cannot finalise ledger without verified receipt + amount + phone',
  });
  await deps.writeAuditEvent?.({
    event_type:     'reconciliation.provider_query.review_required_after_success',
    event_category: 'financial',
    severity:       'critical',
    actor_id:       config.actorId ?? null,
    actor_type:     config.trigger === 'admin_retry' ? 'admin' : 'service',
    target_type:    'pending_payments',
    target_id:      pending.id,
    action:         'hold_for_review_after_provider_success',
    outcome:        'pending',
    payload:        {
      provider_outcome: query.outcome,
      trigger:          config.trigger,
      checkout_request_id: query.checkoutRequestId,
    },
    correlation_id: pending.tx_ref,
  });
  return {
    action:    'transitioned_review_required',
    newStatus: 'review_required',
    reason:    'provider_success_review_required',
  };
}

async function applyTransition(
  pending: PendingPaymentForApply,
  query:    NormalizedStkQuery,
  deps:     ProviderApplyDeps,
  config:   ProviderApplyConfig,
  now:      Date,
  basePayload: Record<string, unknown>,
  newStatus:  'failed' | 'cancelled' | 'timeout',
  eventType:  string,
  reportAction: ProviderApplyReport['action'],
): Promise<ProviderApplyReport> {
  await deps.updatePendingPayment(pending.id, {
    status:                 newStatus,
    result_code:            query.resultCode || '',
    result_desc:            query.resultDesc || `provider_query_${newStatus}`,
    callback_payload_hash:  query.rawPayloadHash,
    updated_at:             now.toISOString(),
  });
  await deps.recordEvent({
    ...basePayload,
    requires_manual_review: false,
    event_type: eventType,
    reason:     `provider reported ${newStatus} via STK Query`,
  });
  await deps.recordEvent({
    ...basePayload,
    requires_manual_review: false,
    event_type: 'provider_query.status_applied',
    reason:     `pending_payments transitioned to ${newStatus}`,
  });
  await deps.writeAuditEvent?.({
    event_type:     `reconciliation.provider_query.${newStatus}`,
    event_category: 'financial',
    severity:       newStatus === 'failed' ? 'warn' : 'info',
    actor_id:       config.actorId ?? null,
    actor_type:     config.trigger === 'admin_retry' ? 'admin' : 'service',
    target_type:    'pending_payments',
    target_id:      pending.id,
    action:         `transition_to_${newStatus}`,
    outcome:        'success',
    payload:        {
      provider_outcome: query.outcome,
      trigger:          config.trigger,
    },
    correlation_id: pending.tx_ref,
  });
  return { action: reportAction, newStatus, reason: `provider_query_${newStatus}` };
}

async function applyStillPending(
  pending: PendingPaymentForApply,
  query:    NormalizedStkQuery,
  deps:     ProviderApplyDeps,
  config:   ProviderApplyConfig,
  now:      Date,
  basePayload: Record<string, unknown>,
): Promise<ProviderApplyReport> {
  const ageMinutes = ageInMinutes(pending, now);
  const overdue = ageMinutes >= config.reviewAfterMinutes;

  await deps.recordEvent({
    ...basePayload,
    requires_manual_review: overdue,
    event_type: 'provider_query.still_pending',
    reason:     `provider says still pending (${ageMinutes}m old)`,
  });
  if (overdue) {
    await deps.updatePendingPayment(pending.id, {
      status:                 'review_required',
      result_desc:            'provider_still_pending_past_review_threshold',
      callback_payload_hash:  query.rawPayloadHash,
      updated_at:             now.toISOString(),
    });
    await deps.recordEvent({
      ...basePayload,
      requires_manual_review: true,
      event_type: 'provider_query.manual_review_required',
      reason:     `still pending after ${ageMinutes}m exceeds review threshold ${config.reviewAfterMinutes}m`,
    });
    await deps.writeAuditEvent?.({
      event_type:     'reconciliation.provider_query.still_pending_overdue',
      event_category: 'financial',
      severity:       'warn',
      actor_id:       config.actorId ?? null,
      actor_type:     config.trigger === 'admin_retry' ? 'admin' : 'service',
      target_type:    'pending_payments',
      target_id:      pending.id,
      action:         'escalate_still_pending',
      outcome:        'pending',
      payload:        { age_minutes: ageMinutes, trigger: config.trigger },
      correlation_id: pending.tx_ref,
    });
    return {
      action:    'transitioned_review_required',
      newStatus: 'review_required',
      reason:    'still_pending_overdue',
    };
  }

  return { action: 'noop_still_pending', newStatus: null, reason: 'still_pending_within_window' };
}

async function applyProviderInconclusive(
  pending: PendingPaymentForApply,
  query:    NormalizedStkQuery,
  deps:     ProviderApplyDeps,
  config:   ProviderApplyConfig,
  now:      Date,
  basePayload: Record<string, unknown>,
): Promise<ProviderApplyReport> {
  const ageMinutes = ageInMinutes(pending, now);
  const overdue = ageMinutes >= config.reviewAfterMinutes;
  const eventType = query.outcome === 'provider_error'
    ? 'provider_query.provider_error'
    : 'provider_query.provider_unknown';

  await deps.recordEvent({
    ...basePayload,
    requires_manual_review: overdue || config.escalateInconclusiveImmediately === true,
    event_type: eventType,
    reason:     `provider ${query.outcome}: ${query.resultDesc || query.resultCode || 'no detail'}`,
  });

  if (overdue || config.escalateInconclusiveImmediately === true) {
    await deps.updatePendingPayment(pending.id, {
      status:                 'review_required',
      result_desc:            `provider_${query.outcome}`,
      callback_payload_hash:  query.rawPayloadHash,
      updated_at:             now.toISOString(),
    });
    await deps.recordEvent({
      ...basePayload,
      requires_manual_review: true,
      event_type: 'provider_query.manual_review_required',
      reason:     `${query.outcome} after ${ageMinutes}m`,
    });
    await deps.writeAuditEvent?.({
      event_type:     `reconciliation.provider_query.${query.outcome}_escalated`,
      event_category: 'financial',
      severity:       'warn',
      actor_id:       config.actorId ?? null,
      actor_type:     config.trigger === 'admin_retry' ? 'admin' : 'service',
      target_type:    'pending_payments',
      target_id:      pending.id,
      action:         `escalate_${query.outcome}`,
      outcome:        'pending',
      payload:        { age_minutes: ageMinutes, trigger: config.trigger },
      correlation_id: pending.tx_ref,
    });
    return {
      action:    'transitioned_review_required',
      newStatus: 'review_required',
      reason:    `${query.outcome}_escalated`,
    };
  }

  return {
    action:    'noop_still_pending',
    newStatus: null,
    reason:    `${query.outcome}_within_window`,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ageInMinutes(row: PendingPaymentForApply, now: Date): number {
  const ref = row.updated_at;
  if (!ref) return Infinity;
  const t = new Date(ref).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}

// Re-export for tests:
export type { ProviderQueryOutcome };
