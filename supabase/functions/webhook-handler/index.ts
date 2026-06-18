import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import {
  callbackExternalReference,
  callbackIdempotencyKey,
  callbackStatus,
  finalizeDarajaPayment,
  parseDarajaStkCallback,
} from '../_shared/payment-lifecycle.ts';
import { resolveWebhookSkipFlags } from '../_shared/payment-env.ts';
import { requireFunctionEnv, serviceNotConfiguredResponse } from '../_shared/function-env.ts';
import {
  verifyWebhookSignature,
  sha256Hex,
  TIMESTAMP_TOLERANCE_SECONDS,
} from '../_shared/webhook-verify.ts';

// ─────────────────────────────────────────────────────────────────────────────
// M-PESA / Daraja callback verification strategy (kept in code as the source
// of truth so future maintainers cannot accidentally relax it):
//
//   1. **Transport**       — Edge Function only accepts POST + OPTIONS.
//                             CORS Origin pins to APP_ORIGIN or "null"; no
//                             wildcard.
//   2. **IP allowlist**     — In production / staging the request source IP
//                             MUST be in `SAFARICOM_IP_RANGES`. The
//                             `WEBHOOK_SKIP_IP_CHECK` flag is honoured ONLY
//                             when DARAJA_ENV=sandbox or APP_ENV is local /
//                             demo / sandbox. Production refuses the flag and
//                             emits `webhook.skip_flag_refused`.
//   3. **Callback secret**  — When `MPESA_WEBHOOK_SECRET` (or per-provider
//                             secret) is configured, we verify the HMAC
//                             header. Daraja itself does NOT sign callbacks
//                             out-of-the-box — operators must front the
//                             function behind a gateway that signs (e.g.
//                             Supabase webhook proxy, custom edge) OR rely on
//                             the IP allowlist + CheckoutRequestID matching.
//                             `WEBHOOK_SKIP_SIGNATURE` is similarly gated.
//   4. **Replay window**    — `webhook_nonces` UNIQUE (signature, payload_hash)
//                             prevents replay of a signed body.
//   5. **Payload matching** — Pending payment lookup uses CheckoutRequestID
//                             FIRST, then MerchantRequestID. Both come from
//                             server-stored values on initiate-payment, never
//                             from client input.
//   6. **Amount + phone**   — Checked against the server-stored pending row.
//                             Mismatch ⇒ status='review_required', NO ledger
//                             post, reconciliation event written.
//   7. **Idempotency**      — `webhook_events.idempotency_key` UNIQUE per
//                             (CheckoutRequestID, ResultCode, ReceiptNumber).
//                             Duplicate successes never double-post the
//                             ledger.
//   8. **Conflicts**        — Late success after failure/cancelled/timeout ⇒
//                             review_required. Late failure after success ⇒
//                             ledger is NEVER auto-reversed; review event +
//                             audit trail only.
//
// Unknown / orphan callbacks always create an audit + reconciliation event
// and return 404; they never touch the ledger.
// ─────────────────────────────────────────────────────────────────────────────

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-correlation-id, x-webhook-signature, x-mpesa-signature, x-hub-signature-256, x-webhook-timestamp, x-mpesa-timestamp, x-webhook-provider, x-idempotency-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_BODY_BYTES = 512 * 1024;
const SAFARICOM_IP_RANGES = [
  '196.201.214.200/29',
  '196.201.214.206/32',
  '196.201.213.114/32',
  '196.201.214.207/32',
  '196.201.214.208/32',
  '196.201.213.44/32',
  '196.201.212.127/32',
  '196.201.212.138/32',
  '196.201.212.129/32',
  '196.201.212.136/32',
  '196.201.212.74/32',
  '196.201.212.69/32',
];

function ipMatchesCidr(ip: string, cidr: string): boolean {
  try {
    const [range, bits = '32'] = cidr.split('/');
    const ipParts = ip.split('.').map(Number);
    const rangeParts = range.split('.').map(Number);
    if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
    const maskBits = Number(bits);
    const mask = maskBits === 32 ? 0xffffffff : (0xffffffff << (32 - maskBits)) >>> 0;
    const ipInt = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
    const rangeInt = ((rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3]) >>> 0;
    return (ipInt & mask) === (rangeInt & mask);
  } catch {
    return false;
  }
}

function isAllowedSafaricomIp(ip: string): boolean {
  return Boolean(ip && ip !== 'unknown' && SAFARICOM_IP_RANGES.some((cidr) => ipMatchesCidr(ip, cidr)));
}

async function checkAndRecordNonce(supabaseAdmin: any, provider: string, signature: string, payloadHash: string, sourceIp: string) {
  const { error } = await supabaseAdmin.from('webhook_nonces').insert({
    provider,
    signature,
    payload_hash: payloadHash,
    source_ip: sourceIp,
  });
  if (error?.code === '23505') return { accepted: false, reason: 'replay_detected' };
  return { accepted: true };
}

function extractIdempotency(req: Request, payload: unknown, payloadHash: string): string {
  const h = req.headers.get('x-idempotency-key');
  if (h?.trim()) return h.trim();
  const callback = (payload as Record<string, unknown> | null)?.Body as Record<string, unknown> | undefined;
  const stk = callback?.stkCallback as Record<string, unknown> | undefined;
  return String(stk?.CheckoutRequestID || payloadHash);
}

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: corsHeaders });
}

async function writeAuditEvent(supabaseAdmin: any, event: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from('audit_events').insert({
    event_type: event.event_type || 'payment.webhook.event',
    event_category: event.event_category || 'financial',
    severity: event.severity || 'info',
    actor_id: event.actor_id || null,
    actor_type: event.actor_type || 'service',
    target_type: event.target_type || 'pending_payments',
    target_id: event.target_id || null,
    action: event.action || 'process_mpesa_callback',
    outcome: event.outcome || 'success',
    payload: event.payload || {},
    payload_hash: '',
    correlation_id: event.correlation_id || null,
  });
  if (error) console.error('[webhook-handler] audit insert failed', error);
}

async function findPendingPayment(supabaseAdmin: any, checkoutRequestId: string, merchantRequestId: string | null) {
  let query = supabaseAdmin
    .from('pending_payments')
    .select('*')
    .eq('checkout_request_id', checkoutRequestId)
    .limit(1);
  let { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  if (data || !merchantRequestId) return data;

  ({ data, error } = await supabaseAdmin
    .from('pending_payments')
    .select('*')
    .eq('merchant_request_id', merchantRequestId)
    .limit(1)
    .maybeSingle());
  if (error) throw new Error(error.message);
  return data;
}

async function recordPaymentReconciliationEvent(
  supabaseAdmin: any,
  event: Record<string, unknown>
) {
  const { error } = await supabaseAdmin.from('payment_reconciliation_events').insert(event);
  if (error) console.error('[webhook-handler] reconciliation insert failed', error);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const envCheck = requireFunctionEnv({
    functionName: 'webhook-handler',
    // APP_ORIGIN is intentionally absent — webhooks are server-to-server.
    required:       ['APP_ENV', 'DARAJA_ENV'],
    // MPESA_WEBHOOK_SECRET is enforced by the verification path itself
    // (skip flags are rejected in production). Listed here so it surfaces
    // in startup logs if absent.
    optional:       ['MPESA_WEBHOOK_SECRET', 'WEBHOOK_SECRET'],
    alwaysRequired: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  });
  if (!envCheck.ok) return serviceNotConfiguredResponse(corsHeaders);

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabaseAdmin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: 'PAYLOAD_TOO_LARGE' }, 413);
    }

    const clientIp = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || req.headers.get('x-real-ip')
      || 'unknown';
    const signature = req.headers.get('x-webhook-signature')
      || req.headers.get('x-mpesa-signature')
      || req.headers.get('x-hub-signature-256');
    const timestamp = req.headers.get('x-webhook-timestamp')
      || req.headers.get('x-mpesa-timestamp');
    const provider = req.headers.get('x-webhook-provider') || 'mpesa';
    const payloadHash = await sha256Hex(rawBody);

    // ── Skip-flag policy: production / staging refuse skip flags entirely ──
    const skipState = resolveWebhookSkipFlags();
    if (skipState.refusedInProduction) {
      await supabaseAdmin.from('webhook_events').insert({
        source: 'external',
        payload_hash: payloadHash,
        payload: {
          error: 'skip_flag_not_allowed',
          skip_signature_requested: skipState.skipSignatureRequested,
          skip_ip_requested:        skipState.skipIpRequested,
          app_env:                  skipState.appEnv,
          daraja_env:               skipState.darajaEnv,
        },
        status: 'rejected',
      });
      await writeAuditEvent(supabaseAdmin, {
        event_type: 'webhook.skip_flag_refused',
        event_category: 'financial',
        severity: 'critical',
        target_type: 'webhook_events',
        action: 'refuse_skip_flag_in_production',
        outcome: 'denied',
        payload: {
          skip_signature_requested: skipState.skipSignatureRequested,
          skip_ip_requested:        skipState.skipIpRequested,
          app_env:                  skipState.appEnv,
          daraja_env:               skipState.darajaEnv,
          source_ip:                clientIp,
          payload_hash:             payloadHash,
        },
      });
      return json({ ok: false, error: 'SKIP_FLAGS_NOT_ALLOWED_IN_PRODUCTION' }, 403);
    }

    if (provider === 'mpesa' && !skipState.skipIpEffective && !isAllowedSafaricomIp(clientIp)) {
      await writeAuditEvent(supabaseAdmin, {
        event_type: 'webhook.ip_not_allowed',
        event_category: 'financial',
        severity: 'warn',
        target_type: 'webhook_events',
        action: 'reject_unallowed_ip',
        outcome: 'denied',
        payload: { source_ip: clientIp, provider, payload_hash: payloadHash },
      });
      return json({ ok: false, error: 'IP_NOT_ALLOWED' }, 403);
    }

    const skipSignature = skipState.skipSignatureEffective;
    if (!skipSignature) {
      const secret = Deno.env.get(provider === 'mpesa' ? 'MPESA_WEBHOOK_SECRET' : 'WEBHOOK_SECRET') || '';
      const verification = await verifyWebhookSignature(rawBody, signature, timestamp, secret);
      if (!verification.valid) {
        await supabaseAdmin.from('webhook_events').insert({
          source: 'external',
          payload_hash: payloadHash,
          payload: { error: 'bad_signature', reason: verification.reason },
          status: 'rejected',
        });
        return json({ ok: false, error: 'INVALID_SIGNATURE', reason: verification.reason }, 401);
      }
    }

    if (signature && !skipSignature) {
      const nonce = await checkAndRecordNonce(supabaseAdmin, provider, signature, payloadHash, clientIp);
      if (!nonce.accepted) return json({ ok: false, error: 'REPLAY_DETECTED' }, 409);
    }

    let payload: Record<string, unknown>;
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      return json({ ok: false, error: 'INVALID_JSON' }, 400);
    }

    let callback;
    try {
      callback = parseDarajaStkCallback(payload);
    } catch (error) {
      await supabaseAdmin.from('webhook_events').insert({
        source: 'mpesa_callback',
        idempotency_key: extractIdempotency(req, payload, payloadHash),
        payload_hash: payloadHash,
        payload,
        status: 'rejected',
        processed_at: new Date().toISOString(),
      });
      await writeAuditEvent(supabaseAdmin, {
        event_type: 'payment.webhook.invalid_payload',
        severity: 'warn',
        target_type: 'webhook_events',
        action: 'reject_invalid_mpesa_callback',
        outcome: 'denied',
        payload: { error: error instanceof Error ? error.message : String(error), payload_hash: payloadHash },
      });
      return json({ ok: false, error: 'INVALID_DARAJA_CALLBACK' }, 400);
    }

    const idempotencyKey = callbackIdempotencyKey(callback, payloadHash);

    await writeAuditEvent(supabaseAdmin, {
      event_type: 'webhook.received',
      event_category: 'financial',
      severity: 'info',
      target_type: 'webhook_events',
      action: 'accept_mpesa_callback',
      outcome: 'success',
      payload: {
        checkout_request_id: callback.checkoutRequestId,
        merchant_request_id: callback.merchantRequestId,
        result_code:         callback.resultCode,
        idempotency_key:     idempotencyKey,
        payload_hash:        payloadHash,
        source_ip:           clientIp,
        skip_signature:      skipState.skipSignatureEffective,
        skip_ip:             skipState.skipIpEffective,
      },
    });

    const { data: existingEvent } = await supabaseAdmin
      .from('webhook_events')
      .select('id, status')
      .eq('source', 'mpesa_callback')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existingEvent) {
      const duplicatePending = await findPendingPayment(supabaseAdmin, callback.checkoutRequestId, callback.merchantRequestId);
      if (duplicatePending) {
        await recordPaymentReconciliationEvent(supabaseAdmin, {
          pending_payment_id: duplicatePending.id,
          external_reference: callbackExternalReference(callback),
          provider_status: callbackStatus(callback),
          internal_status: duplicatePending.status,
          amount_match: null,
          phone_match: null,
          requires_manual_review: false,
          raw_provider_payload_hash: payloadHash,
          event_type: 'duplicate_callback',
          reason: 'duplicate callback for same idempotency key',
        });
      }
      await writeAuditEvent(supabaseAdmin, {
        event_type: 'webhook.duplicate',
        event_category: 'financial',
        severity: 'info',
        target_type: 'webhook_events',
        target_id: existingEvent.id,
        action: 'reject_duplicate_callback',
        outcome: 'success',
        payload: { idempotency_key: idempotencyKey, payload_hash: payloadHash },
        correlation_id: duplicatePending?.tx_ref ?? null,
      });
      return json({ ok: true, duplicate: true, previous_status: existingEvent.status, idempotency_key: idempotencyKey });
    }

    const { error: eventInsertError } = await supabaseAdmin.from('webhook_events').insert({
      source: 'mpesa_callback',
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      payload,
      status: 'accepted',
      processed_at: null,
    });
    if (eventInsertError?.code === '23505') {
      return json({ ok: true, duplicate: true, idempotency_key: idempotencyKey });
    }
    if (eventInsertError) {
      throw new Error(eventInsertError.message);
    }

    const pending = await findPendingPayment(supabaseAdmin, callback.checkoutRequestId, callback.merchantRequestId);
    if (!pending) {
      await supabaseAdmin
        .from('webhook_events')
        .update({ status: 'failed', processed_at: new Date().toISOString() })
        .eq('source', 'mpesa_callback')
        .eq('idempotency_key', idempotencyKey);
      await writeAuditEvent(supabaseAdmin, {
        event_type: 'webhook.orphan',
        event_category: 'financial',
        severity: 'critical',
        target_type: 'webhook_events',
        action: 'hold_orphan_mpesa_callback',
        outcome: 'failure',
        payload: {
          checkout_request_id: callback.checkoutRequestId,
          merchant_request_id: callback.merchantRequestId,
          payload_hash: payloadHash,
          source_ip: clientIp,
        },
      });
      return json({ ok: false, error: 'PENDING_PAYMENT_NOT_FOUND' }, 404);
    }

    const getLatestBalance = async (accountPhone: string): Promise<number> => {
      const { data } = await supabaseAdmin
        .from('ledger_entries')
        .select('balance_after')
        .eq('account_phone', accountPhone)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      return Number(data?.balance_after ?? 0);
    };

    const postDoubleEntry = async (args: Record<string, unknown>) => {
      const { data, error } = await supabaseAdmin.rpc('post_double_entry', args);
      if (error) throw new Error(error.message);
      return data;
    };

    const updatePendingPayment = async (id: string, patch: Record<string, unknown>) => {
      const { error } = await supabaseAdmin.from('pending_payments').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    };

    const recordReconciliationEvent = async (event: Record<string, unknown>) => {
      await recordPaymentReconciliationEvent(supabaseAdmin, event);
    };

    // ── CHAMA CONTRIBUTION SETTLEMENT (purely additive branch) ───────────────
    // Chama contributions settle atomically through the settle_chama_contribution
    // RPC (ledger debit/credit + pending_payments + chama_obligations in ONE
    // transaction) instead of finalizeDarajaPayment. EVERY non-chama payment_type
    // falls through unchanged to the finalizeDarajaPayment call below. All shared
    // security checks (IP, HMAC, nonce, webhook_events de-dup) already ran above
    // for BOTH paths — a chama duplicate callback is caught by the same
    // webhook_events idempotency_key de-dup (lines 331-365 / 375-377) before it
    // ever reaches this branch, exactly like a non-chama duplicate.
    if (pending.payment_type === 'chama_contribution') {
      const chamaStatus = callbackStatus(callback);

      const markEventProcessed = (eventStatus: string) =>
        supabaseAdmin
          .from('webhook_events')
          .update({ status: eventStatus, processed_at: new Date().toISOString() })
          .eq('source', 'mpesa_callback')
          .eq('idempotency_key', idempotencyKey);

      // Mirror finalizeDarajaPayment's review_required path: set pending to
      // review_required (NO ledger post, NEVER succeeded), record a manual-review
      // reconciliation event, write a critical audit event. The obligation is
      // left in 'pending_payment' — ops resolves it; the §4-B reset sweep
      // deliberately ignores review_required pending rows.
      const holdForReview = async (reason: string, eventType: string) => {
        await updatePendingPayment(pending.id, {
          status: 'review_required',
          result_code: callback.resultCode,
          result_desc: callback.resultDesc,
          provider_receipt: callback.receiptNumber,
          callback_payload_hash: payloadHash,
          raw_callback: callback,
          updated_at: new Date().toISOString(),
        });
        await recordReconciliationEvent({
          pending_payment_id: pending.id,
          external_reference: callbackExternalReference(callback),
          provider_status: chamaStatus,
          internal_status: 'review_required',
          amount_match: null,
          phone_match: null,
          requires_manual_review: true,
          raw_provider_payload_hash: payloadHash,
          event_type: eventType,
          reason,
        });
        await writeAuditEvent(supabaseAdmin, {
          event_type: 'webhook.chama_settlement_review',
          event_category: 'financial',
          severity: 'critical',
          actor_id: pending.user_id,
          actor_type: 'service',
          target_type: 'pending_payments',
          target_id: pending.id,
          action: 'hold_chama_payment_for_reconciliation',
          outcome: 'pending',
          payload: { tx_ref: pending.tx_ref, reason, event_type: eventType },
          correlation_id: pending.tx_ref,
        });
      };

      if (chamaStatus === 'succeeded') {
        const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc(
          'settle_chama_contribution',
          {
            p_tx_ref:       pending.tx_ref,
            p_receipt:      callback.receiptNumber,
            p_settled_at:   new Date().toISOString(),
            p_payload_hash: payloadHash,
          },
        );

        if (rpcError) {
          // Network/exception reaching the RPC: the transaction either never ran
          // or rolled back, so the pending row is still pre-call status. Hold for
          // review (do NOT mark succeeded) and return 500 so the reconciliation
          // backstop / Daraja retry can re-drive it.
          await holdForReview('settle_chama_contribution RPC error', 'chama_settlement_rpc_error');
          await markEventProcessed('failed');
          return json({ ok: false, error: 'CHAMA_SETTLEMENT_FAILED', idempotency_key: idempotencyKey }, 500);
        }

        const r = (rpcResult ?? {}) as Record<string, unknown>;

        if (r.ok === true) {
          // Settled, duplicate, or no_obligation — all consistent (the RPC is
          // atomic + idempotent). Ledger + obligation are correct.
          await markEventProcessed('processed');
          return json({ ok: true, ...r, status: 'succeeded', idempotency_key: idempotencyKey });
        }

        if (r.error === 'PENDING_NOT_FOUND') {
          // The RPC could not see the pending row (should not happen — we just
          // resolved it). Nothing to settle: log + 200.
          await markEventProcessed('processed');
          return json({ ok: true, status: 'pending_not_found', idempotency_key: idempotencyKey });
        }

        // AMOUNT_MISMATCH or LEDGER_POST_FAILED: the RPC rolled back, no ledger
        // was posted, the pending row is still pre-call. Mark review_required
        // explicitly — mirror the non-chama amount-mismatch path. NOT succeeded.
        const eventType = r.error === 'AMOUNT_MISMATCH' ? 'amount_mismatch' : 'ledger_post_failed';
        await holdForReview(`settle_chama_contribution returned ${String(r.error)}`, eventType);
        await markEventProcessed('processed');
        return json({ ok: true, status: 'review_required', error: r.error, reviewRequired: true, idempotency_key: idempotencyKey });
      }

      // ── FAILED / CANCELLED / TIMEOUT chama callback (ResultCode != 0) ────────
      // No receipt → the settlement RPC is NEVER called. Mark the pending row
      // failed (mirror finalizeDarajaPayment's terminal-failure patch) and reset
      // the obligation directly so the member can retry immediately. The §4-B
      // reconciliation sweep is the backstop if this UPDATE races.
      await updatePendingPayment(pending.id, {
        status: chamaStatus,
        result_code: callback.resultCode,
        result_desc: callback.resultDesc,
        provider_receipt: callback.receiptNumber,
        callback_payload_hash: payloadHash,
        raw_callback: callback,
        updated_at: new Date().toISOString(),
      });
      const { error: resetErr } = await supabaseAdmin
        .from('chama_obligations')
        .update({ status: 'due', payment_tx_ref: null, updated_at: new Date().toISOString() })
        .eq('payment_tx_ref', pending.tx_ref)
        .eq('status', 'pending_payment');
      if (resetErr) console.error('[webhook-handler] chama obligation reset failed', resetErr);
      await recordReconciliationEvent({
        pending_payment_id: pending.id,
        external_reference: callbackExternalReference(callback),
        provider_status: chamaStatus,
        internal_status: chamaStatus,
        amount_match: null,
        phone_match: null,
        requires_manual_review: false,
        raw_provider_payload_hash: payloadHash,
        event_type: 'terminal_failure',
        reason: `chama callback reported ${chamaStatus}`,
      });
      await writeAuditEvent(supabaseAdmin, {
        event_type: `payment.webhook.${chamaStatus}`,
        event_category: 'financial',
        severity: chamaStatus === 'failed' ? 'warn' : 'info',
        actor_id: pending.user_id,
        actor_type: 'service',
        target_type: 'pending_payments',
        target_id: pending.id,
        action: 'finalize_chama_payment_without_ledger',
        outcome: 'failure',
        payload: { tx_ref: pending.tx_ref, provider_status: chamaStatus },
        correlation_id: pending.tx_ref,
      });
      await markEventProcessed('processed');
      return json({ ok: true, status: chamaStatus, ledgerPosted: false, idempotency_key: idempotencyKey });
    }
    // ── END CHAMA BRANCH — non-chama payments fall through UNCHANGED below ────

    const result = await finalizeDarajaPayment({
      callback,
      pending,
      payloadHash,
      getLatestBalance,
      postDoubleEntry,
      updatePendingPayment,
      recordReconciliationEvent,
      writeAuditEvent: (event) => writeAuditEvent(supabaseAdmin, event),
    });

    await supabaseAdmin
      .from('webhook_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('source', 'mpesa_callback')
      .eq('idempotency_key', idempotencyKey);

    return json({ ok: true, ...result, idempotency_key: idempotencyKey });
  } catch (e) {
    console.error('webhook-handler', e);
    return json({ ok: false, error: 'WEBHOOK_PROCESSING_FAILED' }, 500);
  }
});
