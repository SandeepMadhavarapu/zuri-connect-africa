import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { isDarajaQueryConfigured } from '../_shared/payment-env.ts';
import {
  sweepStuckPendingPayments,
  type StuckRow,
  type ProviderQueryResult,
} from '../_shared/stuck-payments.ts';
import { queryStkPush, readStkQueryEnv } from '../_shared/daraja-query.ts';
import {
  applyProviderQueryResult,
  type PendingPaymentForApply,
} from '../_shared/provider-status-applier.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';
const ADMIN_ROLES = new Set(['admin', 'auditor']);

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_STUCK_MINUTES  = 30;
const DEFAULT_REVIEW_MINUTES = 120;

function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') {
    return Response.json({ ok: false, error: 'method_not_allowed' }, { status: 405, headers: corsHeaders });
  }

  const url        = Deno.env.get('SUPABASE_URL') || '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !serviceKey) {
    return Response.json({ ok: false, error: 'service_not_configured' }, { status: 500, headers: corsHeaders });
  }

  // ── 1. Require authenticated user ────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return Response.json({ ok: false, error: 'missing_authorization' }, { status: 401, headers: corsHeaders });
  }

  const supabaseAdmin = createClient(url, serviceKey);
  const { data: userRes, error: authErr } = await supabaseAdmin.auth.getUser(jwt);
  if (authErr || !userRes.user) {
    return Response.json({ ok: false, error: 'invalid_token' }, { status: 401, headers: corsHeaders });
  }

  // ── 2. Require admin or auditor role (app_metadata only — user-writable fields rejected) ──
  const role = ((userRes.user.app_metadata?.role) ?? '').toLowerCase();
  if (!ADMIN_ROLES.has(role)) {
    return Response.json({ ok: false, error: 'forbidden', message: 'Insufficient privileges to trigger reconciliation.' }, { status: 403, headers: corsHeaders });
  }

  try {
    const { data: ledgerData, error: ledgerErr } = await supabaseAdmin.rpc('run_reconciliation', { p_run_type: 'manual' });
    if (ledgerErr) {
      return Response.json({ ok: false, error: 'recon_rpc_failed', message: ledgerErr.message }, { status: 500, headers: corsHeaders });
    }

    const stuckMinutes  = envInt('RECONCILIATION_STUCK_AFTER_MINUTES',  DEFAULT_STUCK_MINUTES);
    const reviewMinutes = envInt('RECONCILIATION_REVIEW_AFTER_MINUTES', DEFAULT_REVIEW_MINUTES);

    const providerQueryConfigured = isDarajaQueryConfigured();

    // ── Real Daraja STK Query integration ────────────────────────────────
    // When the provider secrets are configured we ask Daraja for the latest
    // known status of each stuck pending_payment, then route the answer
    // through `applyProviderQueryResult` which enforces:
    //   * never post to ledger
    //   * never double-finalise an already-terminal row
    //   * STK Query "succeeded" ⇒ review_required (no receipt/amount in
    //     STK Query response — cannot finalise the ledger safely)
    //   * failed/cancelled/timeout ⇒ apply the terminal status
    //   * still_pending/unknown/error ⇒ leave for now, escalate after threshold
    //
    // The sweep below ALSO runs after this so any remaining rows that were
    // genuinely orphaned (no provider channel, no callback) become 'timeout'.
    let providerQueryApplied = {
      attempted: 0,
      succeeded_review: 0,
      failed: 0,
      cancelled: 0,
      timeout: 0,
      still_pending: 0,
      review_escalated: 0,
      provider_errors: 0,
      skipped_terminal: 0,
    };

    if (providerQueryConfigured) {
      providerQueryApplied = await runProviderQuerySweep({
        supabaseAdmin,
        actorId: userRes.user.id,
        stuckMinutes,
        reviewMinutes,
      });
    }

    const queryProviderStatus = providerQueryConfigured
      ? async (_row: StuckRow): Promise<ProviderQueryResult> => ({ ok: true, outcome: 'still_pending' })
      : undefined;

    const report = await sweepStuckPendingPayments(
      {
        fetchStuck: async (cutoffIso) => {
          const { data, error } = await supabaseAdmin
            .from('pending_payments')
            .select('id, tx_ref, user_id, status, amount, from_phone, to_phone, checkout_request_id, merchant_request_id, updated_at, created_at')
            .in('status', ['processing', 'waiting_for_mpesa'])
            .lt('updated_at', cutoffIso)
            .limit(200);
          if (error) throw new Error(error.message);
          return (data ?? []) as StuckRow[];
        },
        markTimeout: async (id, patch) => {
          const { error } = await supabaseAdmin.from('pending_payments').update(patch).eq('id', id);
          if (error) throw new Error(error.message);
        },
        markReview: async (id, patch) => {
          const { error } = await supabaseAdmin.from('pending_payments').update(patch).eq('id', id);
          if (error) throw new Error(error.message);
        },
        recordEvent: async (event) => {
          const { error } = await supabaseAdmin.from('payment_reconciliation_events').insert(event);
          if (error) console.error('[reconciliation-job] event insert failed', error);
        },
        writeAuditEvent: async (event) => {
          const { error } = await supabaseAdmin.from('audit_events').insert({
            event_type:     event.event_type     ?? 'reconciliation.event',
            event_category: event.event_category ?? 'financial',
            severity:       event.severity       ?? 'info',
            actor_id:       userRes.user.id,
            actor_type:     'service',
            target_type:    event.target_type    ?? 'pending_payments',
            target_id:      event.target_id      ?? null,
            action:         event.action         ?? 'reconciliation_sweep',
            outcome:        event.outcome        ?? 'success',
            payload:        event.payload        ?? {},
            payload_hash:   '',
            correlation_id: event.correlation_id ?? null,
          });
          if (error) console.error('[reconciliation-job] audit insert failed', error);
        },
        queryProviderStatus,
        providerQueryConfigured,
      },
      {
        stuckAfterMinutes:  stuckMinutes,
        reviewAfterMinutes: reviewMinutes,
      },
    );

    // ── Chama obligation reset sweep (design §4-B) ───────────────────────────
    // Runs AFTER sweepStuckPendingPayments (which is unchanged above). Any chama
    // obligation still stuck in 'pending_payment' whose linked pending_payments
    // row reached a TERMINAL FAILURE state (failed/cancelled/timeout) is reset to
    // 'due' so the member can retry. Obligations whose pending row is
    // 'review_required' are deliberately left for ops (§4-B/§4-C). Idempotent:
    // the UPDATE guards on status='pending_payment'.
    const chamaObligationReset = await resetStuckChamaObligations(supabaseAdmin);

    return Response.json(
      {
        ok: true,
        result: ledgerData,
        stuck_payments: report,
        provider_query: providerQueryApplied,
        chama_obligation_reset: chamaObligationReset,
      },
      { headers: corsHeaders },
    );
  } catch (e) {
    return Response.json({ ok: false, error: 'recon_exception', message: (e as Error).message }, { status: 500, headers: corsHeaders });
  }
});

// ── Provider-query sweep helper ──────────────────────────────────────────

async function runProviderQuerySweep({
  supabaseAdmin,
  actorId,
  stuckMinutes,
  reviewMinutes,
}: {
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any;
  actorId: string;
  stuckMinutes: number;
  reviewMinutes: number;
}) {
  const counters = {
    attempted: 0,
    succeeded_review: 0,
    failed: 0,
    cancelled: 0,
    timeout: 0,
    still_pending: 0,
    review_escalated: 0,
    provider_errors: 0,
    skipped_terminal: 0,
  };

  const cutoff = new Date(Date.now() - stuckMinutes * 60_000).toISOString();
  const { data: rows, error: fetchErr } = await supabaseAdmin
    .from('pending_payments')
    .select('id, tx_ref, user_id, status, amount, from_phone, to_phone, checkout_request_id, merchant_request_id, updated_at, ledger_posted_at')
    .in('status', ['processing', 'waiting_for_mpesa'])
    .lt('updated_at', cutoff)
    .not('checkout_request_id', 'is', null)
    .limit(50);
  if (fetchErr) {
    console.error('[reconciliation-job] fetch stuck rows failed', { code: fetchErr.code });
    return counters;
  }

  const recordEvent = async (event: Record<string, unknown>) => {
    const { error } = await supabaseAdmin.from('payment_reconciliation_events').insert(event);
    if (error) console.error('[reconciliation-job] event insert failed', error);
  };
  const writeAuditEvent = async (event: Record<string, unknown>) => {
    const { error } = await supabaseAdmin.from('audit_events').insert({
      ...event,
      payload_hash: '',
    });
    if (error) console.error('[reconciliation-job] audit insert failed', error);
  };
  const updatePendingPayment = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await supabaseAdmin.from('pending_payments').update(patch).eq('id', id);
    if (error) throw new Error(error.message);
  };

  for (const r of rows ?? []) {
    const row = r as PendingPaymentForApply;
    if (!row.checkout_request_id) {
      counters.skipped_terminal += 1;
      continue;
    }
    counters.attempted += 1;

    const stkInput = readStkQueryEnv(row.checkout_request_id, row.merchant_request_id ?? null);
    if (!stkInput) {
      counters.provider_errors += 1;
      await recordEvent({
        pending_payment_id: row.id,
        external_reference: row.checkout_request_id,
        provider_status:    'provider_error',
        internal_status:    row.status,
        amount_match:       null,
        phone_match:        null,
        requires_manual_review: false,
        raw_provider_payload_hash: '',
        event_type: 'provider_query.provider_error',
        reason:     'daraja secrets not fully configured',
      });
      continue;
    }

    await recordEvent({
      pending_payment_id: row.id,
      external_reference: row.checkout_request_id,
      provider_status:    'requested',
      internal_status:    row.status,
      amount_match:       null,
      phone_match:        null,
      requires_manual_review: false,
      raw_provider_payload_hash: '',
      event_type: 'provider_query.requested',
      reason:     'reconciliation sweep provider query',
    });

    const result = await queryStkPush(stkInput);
    const report = await applyProviderQueryResult(
      row,
      result,
      { updatePendingPayment, recordEvent, writeAuditEvent },
      {
        reviewAfterMinutes: reviewMinutes,
        trigger: 'reconciliation_sweep',
        actorId,
      },
    );

    switch (report.action) {
      case 'transitioned_review_required':
        counters.succeeded_review += result.outcome === 'succeeded' ? 1 : 0;
        counters.review_escalated += result.outcome === 'succeeded' ? 0 : 1;
        break;
      case 'transitioned_failed':    counters.failed += 1; break;
      case 'transitioned_cancelled': counters.cancelled += 1; break;
      case 'transitioned_timeout':   counters.timeout += 1; break;
      case 'noop_still_pending':     counters.still_pending += 1; break;
      case 'noop_already_terminal':
      case 'noop_ledger_posted':
        counters.skipped_terminal += 1; break;
      default:
        // Should not happen, but make TS happy.
        break;
    }
  }

  return counters;
}

// ── Chama obligation reset sweep (design §4-B) ─────────────────────────────
//
// Implements the JOIN from design section 4-B without a SQL view:
//
//   SELECT ob.id FROM chama_obligations ob
//   JOIN pending_payments pp ON pp.tx_ref = ob.payment_tx_ref
//   WHERE ob.status = 'pending_payment'
//     AND pp.status IN ('failed','cancelled','timeout')
//
// For each match: reset chama_obligations to status='due', payment_tx_ref=NULL
// so the member can retry. The UPDATE is guarded on status='pending_payment'
// (idempotent — concurrent resets and already-reset rows are no-ops). Obligations
// whose linked pending row is 'review_required' are NOT reset: those need ops
// review (§4-B/§4-C). Never touches the ledger.
async function resetStuckChamaObligations(
  // deno-lint-ignore no-explicit-any
  supabaseAdmin: any,
): Promise<{ scanned: number; reset: number }> {
  const summary = { scanned: 0, reset: 0 };

  // 1. Obligations stuck in pending_payment with a linked tx_ref.
  const { data: obligations, error: obErr } = await supabaseAdmin
    .from('chama_obligations')
    .select('id, payment_tx_ref')
    .eq('status', 'pending_payment')
    .not('payment_tx_ref', 'is', null)
    .limit(200);
  if (obErr) {
    console.error('[reconciliation-job] chama obligation fetch failed', { code: obErr.code });
    return summary;
  }

  const rows = (obligations ?? []) as Array<{ id: string; payment_tx_ref: string }>;
  const txRefs = rows.map((o) => o.payment_tx_ref);
  if (txRefs.length === 0) return summary;
  summary.scanned = txRefs.length;

  // 2. Linked pending rows in a TERMINAL FAILURE state. 'review_required' is
  //    deliberately excluded so ops-held rows are never auto-reset.
  const { data: failedPending, error: ppErr } = await supabaseAdmin
    .from('pending_payments')
    .select('tx_ref')
    .in('tx_ref', txRefs)
    .in('status', ['failed', 'cancelled', 'timeout']);
  if (ppErr) {
    console.error('[reconciliation-job] chama pending lookup failed', { code: ppErr.code });
    return summary;
  }

  const resettableRefs = new Set(
    ((failedPending ?? []) as Array<{ tx_ref: string }>).map((p) => p.tx_ref),
  );

  // 3. Reset each matched obligation, idempotently guarded on pending_payment.
  for (const ob of rows) {
    if (!resettableRefs.has(ob.payment_tx_ref)) continue;
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('chama_obligations')
      .update({ status: 'due', payment_tx_ref: null, updated_at: new Date().toISOString() })
      .eq('id', ob.id)
      .eq('status', 'pending_payment')
      .select('id');
    if (updErr) {
      console.error('[reconciliation-job] chama obligation reset failed', { code: updErr.code });
      continue;
    }
    if (updated && updated.length > 0) summary.reset += 1;
  }

  console.info(JSON.stringify({
    ts: new Date().toISOString(),
    fn: 'reconciliation-job',
    evt: 'chama_obligation_reset_sweep',
    scanned: summary.scanned,
    reset: summary.reset,
  }));

  return summary;
}
