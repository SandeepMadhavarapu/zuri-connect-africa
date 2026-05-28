/**
 * Zuri Connect Africa — stuck-payment reconciliation sweep.
 *
 * Pending payments stuck in `waiting_for_mpesa` or `processing` past the
 * configured timeout cannot be left to age forever. The sweep moves them to
 * either `timeout` (no further provider info) or `review_required` (provider
 * query failed / inconclusive), always:
 *
 *   * WITHOUT posting to the ledger,
 *   * WITHOUT changing any payment that has already reached a terminal status,
 *   * WITHOUT trusting any client-supplied fields,
 *   * recording a `payment_reconciliation_events` row for each action,
 *   * emitting an `audit_events` security event for ops dashboards.
 *
 * The sweep is pure with respect to its dependencies so it can be unit-tested
 * end-to-end without a real Postgres / Daraja runtime.
 */

export type StuckSweepDeps = {
  /** Returns rows from `pending_payments` newer than the deadlines below. */
  fetchStuck: (cutoffIso: string) => Promise<StuckRow[]>;
  /** Atomically transitions a row out of `processing/waiting_for_mpesa`. */
  markTimeout: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** Atomically transitions a row to `review_required`. */
  markReview: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  /** Append-only `payment_reconciliation_events` writer. */
  recordEvent: (event: Record<string, unknown>) => Promise<unknown>;
  /** Optional `audit_events` writer. */
  writeAuditEvent?: (event: Record<string, unknown>) => Promise<unknown>;
  /**
   * Optional provider-status probe. When undefined OR when it throws, the
   * sweep falls back to status='review_required' (or 'timeout' if no probe
   * was even possible — see `providerQueryConfigured`).
   */
  queryProviderStatus?: (row: StuckRow) => Promise<ProviderQueryResult>;
  /**
   * Set to true only when the Daraja query API is configured. Distinguishes
   * "we tried and failed" (=> review_required) from "we have no provider
   * channel here" (=> plain timeout).
   */
  providerQueryConfigured?: boolean;
  /** Override clock for tests. */
  now?: () => Date;
};

export type StuckRow = {
  id: string;
  tx_ref: string;
  user_id?: string | null;
  status: string;
  amount: number | string;
  from_phone: string;
  to_phone: string;
  checkout_request_id?: string | null;
  merchant_request_id?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

export type ProviderQueryResult =
  | { ok: true; outcome: 'still_pending' | 'succeeded' | 'failed' | 'cancelled' | 'timeout' | 'unknown' }
  | { ok: false; reason: string };

export type StuckSweepConfig = {
  /** Minutes after which a still-processing payment becomes stuck. */
  stuckAfterMinutes: number;
  /** Minutes after which a stuck payment is escalated to review. */
  reviewAfterMinutes: number;
};

export type StuckSweepReport = {
  totalScanned:        number;
  timedOut:            number;
  flaggedForReview:    number;
  providerQueryFailed: number;
  skippedAlreadyTerminal: number;
};

const TERMINAL_STATUSES = new Set([
  'succeeded', 'completed', 'confirmed', 'settled',
  'failed', 'cancelled', 'canceled', 'timeout',
  'review_required', 'reversed',
]);

const PROCESSING_STATUSES = new Set(['processing', 'waiting_for_mpesa']);

export async function sweepStuckPendingPayments(
  deps: StuckSweepDeps,
  config: StuckSweepConfig,
): Promise<StuckSweepReport> {
  const now = (deps.now ?? (() => new Date()))();
  const stuckCutoff = new Date(now.getTime() - config.stuckAfterMinutes * 60_000);

  const rows = await deps.fetchStuck(stuckCutoff.toISOString());
  const report: StuckSweepReport = {
    totalScanned: rows.length,
    timedOut: 0,
    flaggedForReview: 0,
    providerQueryFailed: 0,
    skippedAlreadyTerminal: 0,
  };

  for (const row of rows) {
    // Defence in depth: never mutate an already-terminal row.
    if (TERMINAL_STATUSES.has(String(row.status))) {
      report.skippedAlreadyTerminal += 1;
      continue;
    }
    if (!PROCESSING_STATUSES.has(String(row.status))) {
      // Unknown status — refuse to act and emit a security event for ops.
      report.skippedAlreadyTerminal += 1;
      await deps.writeAuditEvent?.({
        event_type:     'reconciliation.unknown_status',
        event_category: 'financial',
        severity:       'warn',
        target_type:    'pending_payments',
        target_id:      row.id,
        action:         'skip_unknown_status',
        outcome:        'denied',
        payload:        { tx_ref: row.tx_ref, status: row.status },
        correlation_id: row.tx_ref,
      });
      continue;
    }

    const ageMinutes = ageInMinutes(row, now);
    const escalateToReview = ageMinutes >= config.reviewAfterMinutes;

    // ── Optionally probe the provider for the latest known status ──────────
    let providerOutcome: ProviderQueryResult | null = null;
    if (deps.queryProviderStatus) {
      try {
        providerOutcome = await deps.queryProviderStatus(row);
      } catch (e) {
        providerOutcome = { ok: false, reason: (e as Error)?.name ?? 'query_failed' };
      }
    }

    if (providerOutcome && providerOutcome.ok === false) {
      report.providerQueryFailed += 1;
      await deps.recordEvent({
        pending_payment_id: row.id,
        external_reference: row.checkout_request_id || row.tx_ref,
        provider_status:    'query_failed',
        internal_status:    row.status,
        amount_match:       null,
        phone_match:        null,
        requires_manual_review: true,
        raw_provider_payload_hash: '',
        event_type:         'provider_query_failed',
        reason:             `provider query failed: ${providerOutcome.reason}`,
      });
      await deps.markReview(row.id, {
        status: 'review_required',
        result_desc: 'reconciliation_provider_query_failed',
        updated_at: now.toISOString(),
      });
      await deps.writeAuditEvent?.({
        event_type:     'reconciliation.provider_query_failed',
        event_category: 'financial',
        severity:       'warn',
        target_type:    'pending_payments',
        target_id:      row.id,
        action:         'flag_for_manual_review',
        outcome:        'pending',
        payload:        { tx_ref: row.tx_ref, age_minutes: ageMinutes, reason: providerOutcome.reason },
        correlation_id: row.tx_ref,
      });
      report.flaggedForReview += 1;
      continue;
    }

    // Provider says it's already done — let the regular callback path resolve
    // it later, but stamp a reconciliation event for visibility.
    if (providerOutcome?.ok === true && providerOutcome.outcome === 'still_pending') {
      // Still pending downstream — only escalate if it's older than the
      // review threshold; otherwise leave it for the next sweep.
      if (!escalateToReview) {
        continue;
      }
    }

    if (escalateToReview) {
      await deps.markReview(row.id, {
        status: 'review_required',
        result_desc: providerOutcome?.ok ? `provider_${providerOutcome.outcome}` : 'reconciliation_review_required',
        updated_at: now.toISOString(),
      });
      await deps.recordEvent({
        pending_payment_id: row.id,
        external_reference: row.checkout_request_id || row.tx_ref,
        provider_status:    providerOutcome?.ok ? providerOutcome.outcome : 'unknown',
        internal_status:    row.status,
        amount_match:       null,
        phone_match:        null,
        requires_manual_review: true,
        raw_provider_payload_hash: '',
        event_type:         'stuck_review_required',
        reason:             `stuck ${ageMinutes}m past review threshold`,
      });
      await deps.writeAuditEvent?.({
        event_type:     'reconciliation.review_required',
        event_category: 'financial',
        severity:       'critical',
        target_type:    'pending_payments',
        target_id:      row.id,
        action:         'escalate_stuck_payment',
        outcome:        'pending',
        payload:        { tx_ref: row.tx_ref, age_minutes: ageMinutes, provider_outcome: providerOutcome ?? null },
        correlation_id: row.tx_ref,
      });
      report.flaggedForReview += 1;
      continue;
    }

    // Plain timeout — no provider channel available or provider said unknown.
    // Use 'timeout' only when we have ANY confidence the payment didn't
    // succeed; otherwise default to review.
    const allowPlainTimeout =
      !deps.providerQueryConfigured ||
      (providerOutcome?.ok === true &&
        ['failed', 'cancelled', 'timeout', 'unknown'].includes(providerOutcome.outcome));

    if (allowPlainTimeout) {
      await deps.markTimeout(row.id, {
        status: 'timeout',
        result_desc: providerOutcome?.ok ? `provider_${providerOutcome.outcome}` : 'reconciliation_timeout',
        updated_at: now.toISOString(),
      });
      await deps.recordEvent({
        pending_payment_id: row.id,
        external_reference: row.checkout_request_id || row.tx_ref,
        provider_status:    providerOutcome?.ok ? providerOutcome.outcome : 'unknown',
        internal_status:    row.status,
        amount_match:       null,
        phone_match:        null,
        requires_manual_review: false,
        raw_provider_payload_hash: '',
        event_type:         'stuck_timeout',
        reason:             `payment timed out after ${ageMinutes}m without callback`,
      });
      await deps.writeAuditEvent?.({
        event_type:     'reconciliation.timeout',
        event_category: 'financial',
        severity:       'warn',
        target_type:    'pending_payments',
        target_id:      row.id,
        action:         'mark_payment_timeout',
        outcome:        'success',
        payload:        { tx_ref: row.tx_ref, age_minutes: ageMinutes },
        correlation_id: row.tx_ref,
      });
      report.timedOut += 1;
      continue;
    }

    // Provider channel is configured but didn't return a useful status — be
    // conservative and escalate.
    await deps.markReview(row.id, {
      status: 'review_required',
      result_desc: 'reconciliation_review_required',
      updated_at: now.toISOString(),
    });
    await deps.recordEvent({
      pending_payment_id: row.id,
      external_reference: row.checkout_request_id || row.tx_ref,
      provider_status:    'unknown',
      internal_status:    row.status,
      amount_match:       null,
      phone_match:        null,
      requires_manual_review: true,
      raw_provider_payload_hash: '',
      event_type:         'stuck_review_required',
      reason:             'provider configured but returned no actionable status',
    });
    report.flaggedForReview += 1;
  }

  return report;
}

function ageInMinutes(row: StuckRow, now: Date): number {
  const ref = row.updated_at || row.created_at;
  if (!ref) return Infinity;
  const t = new Date(ref).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}
