/**
 * Zuri Connect Africa — admin reconciliation client.
 *
 * The browser MUST NOT query `pending_payments`, `payment_reconciliation_events`,
 * `payment_reconciliation_review`, `webhook_events`, or any other privileged
 * table directly. Every read and every action is mediated by the
 * `admin-reconciliation` Supabase Edge Function (service-role + role check
 * from `app_metadata`).
 *
 * This module is the single entry point and is intentionally thin so the
 * admin UI cannot accidentally bypass the Edge Function.
 */

import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

const FUNCTION_NAME = 'admin-reconciliation';

async function invoke(action, body = {}) {
  const client = getSupabaseBrowserClient();
  if (!client?.functions?.invoke) {
    return { ok: false, error: 'supabase_unavailable' };
  }
  try {
    const { data, error } = await client.functions.invoke(FUNCTION_NAME, {
      body: { action, ...body },
    });
    if (error) {
      return { ok: false, error: error.message || 'invoke_failed', status: error.status };
    }
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'invalid_response' };
    }
    return data;
  } catch (e) {
    return { ok: false, error: e?.message || 'invoke_failed' };
  }
}

export async function fetchReconciliationCounts() {
  return invoke('counts');
}

export async function fetchReconciliationQueue({ filter = 'all', limit = 50 } = {}) {
  return invoke('queue', { filter, limit });
}

export async function markReviewResolved({ pendingPaymentId, note }) {
  return invoke('mark_review_resolved', { pending_payment_id: pendingPaymentId, note });
}

export async function escalateToSupport({ pendingPaymentId, note }) {
  return invoke('escalate_to_support', { pending_payment_id: pendingPaymentId, note });
}

export async function markTimeoutAcknowledged({ pendingPaymentId, note }) {
  return invoke('mark_timeout_acknowledged', { pending_payment_id: pendingPaymentId, note });
}

export async function rejectOrphanCallback({ reconciliationEventId, note }) {
  return invoke('reject_orphan_callback', { reconciliation_event_id: reconciliationEventId, note });
}

export async function retryProviderQuery({ pendingPaymentId }) {
  return invoke('retry_provider_query', { pending_payment_id: pendingPaymentId });
}

/** Marker constant so tests can prove the page only goes through Edge Function. */
export const ADMIN_RECONCILIATION_FUNCTION_NAME = FUNCTION_NAME;
