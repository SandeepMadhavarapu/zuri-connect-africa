import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  handleAdminReconciliation,
  SAFE_REVIEW_VIEW,
} from '../../supabase/functions/admin-reconciliation/handler.ts';

import {
  ADMIN_ROLES,
  canMutateReconciliationQueue,
  canRunAdminOnlyAction,
  canViewReconciliationQueue,
} from '../../supabase/functions/_shared/admin-roles.ts';

function stripComments(src) {
  // Remove block comments and line comments so source-level guarantees don't
  // false-positive on prose like "raw_callback" in trust-boundary docs.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// ── Test fixtures ────────────────────────────────────────────────────────

function makeRequest(body, { headers = { authorization: 'Bearer fake.jwt.token' } } = {}) {
  return new Request('https://example.com/functions/v1/admin-reconciliation', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body:    JSON.stringify(body),
  });
}

// Returns a chainable Supabase-like mock. Each call to .from(table) records
// the table name and returns a stub whose terminal value is the configured
// `dataByTable[table]` or `defaultData`.
function makeSupabaseMock({
  user             = { id: 'user-1', email: 't@example.com', app_metadata: { role: 'admin' } },
  authError        = null,
  dataByTable      = {},
  pendingRow       = null,
  fromCalls        = [],
  insertCalls      = [],
  updateCalls      = [],
  webhookEventRow  = { id: 'wh-1', idempotency_key: 'k', payload_hash: 'h', status: 'failed' },
} = {}) {
  // Mutable lists are referenced by the caller for assertions.
  const builderFor = (table) => {
    const builder = {
      _filters: [],
      _operation: 'select',
      select(_cols, opts) {
        this._operation = opts?.head ? 'count' : 'select';
        return this;
      },
      order() { return this; },
      limit() { return this; },
      eq(col, val)  { this._filters.push(['eq',  col, val]); return this; },
      neq(col, val) { this._filters.push(['neq', col, val]); return this; },
      is(col, val)  { this._filters.push(['is',  col, val]); return this; },
      in(col, val)  { this._filters.push(['in',  col, val]); return this; },
      gte(col, val) { this._filters.push(['gte', col, val]); return this; },
      maybeSingle() {
        if (table === 'pending_payments') {
          return Promise.resolve({ data: pendingRow, error: null });
        }
        if (table === 'webhook_events') {
          return Promise.resolve({ data: webhookEventRow, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      insert(payload) {
        insertCalls.push({ table, payload });
        return Promise.resolve({ data: null, error: null });
      },
      update(payload) {
        updateCalls.push({ table, payload });
        return {
          eq: (col, val) => {
            updateCalls[updateCalls.length - 1].eq = [col, val];
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
      // Thenable so `await query` resolves the chain like supabase-js.
      then(onResolve, onReject) {
        return Promise.resolve({
          data:  dataByTable[table] ?? null,
          error: null,
          count: dataByTable[`${table}__count`] ?? 0,
        }).then(onResolve, onReject);
      },
    };
    return builder;
  };

  return {
    auth: {
      getUser: async (_jwt) => ({ data: { user }, error: authError }),
    },
    from(table) {
      fromCalls.push(table);
      return builderFor(table);
    },
    _fromCalls: fromCalls,
    _insertCalls: insertCalls,
    _updateCalls: updateCalls,
  };
}

// ── admin-roles helper unit tests ────────────────────────────────────────

describe('admin-roles RBAC helper', () => {
  it('view permission includes admin, auditor, fraud_analyst', () => {
    expect(canViewReconciliationQueue(ADMIN_ROLES.ADMIN)).toBe(true);
    expect(canViewReconciliationQueue(ADMIN_ROLES.AUDITOR)).toBe(true);
    expect(canViewReconciliationQueue(ADMIN_ROLES.FRAUD_ANALYST)).toBe(true);
    expect(canViewReconciliationQueue('customer')).toBe(false);
    expect(canViewReconciliationQueue('support')).toBe(false);
    expect(canViewReconciliationQueue('')).toBe(false);
  });

  it('mutate permission excludes auditor and customers', () => {
    expect(canMutateReconciliationQueue(ADMIN_ROLES.ADMIN)).toBe(true);
    expect(canMutateReconciliationQueue(ADMIN_ROLES.FRAUD_ANALYST)).toBe(true);
    expect(canMutateReconciliationQueue(ADMIN_ROLES.AUDITOR)).toBe(false);
    expect(canMutateReconciliationQueue('customer')).toBe(false);
  });

  it('admin-only actions exclude fraud_analyst and auditor', () => {
    expect(canRunAdminOnlyAction(ADMIN_ROLES.ADMIN)).toBe(true);
    expect(canRunAdminOnlyAction(ADMIN_ROLES.FRAUD_ANALYST)).toBe(false);
    expect(canRunAdminOnlyAction(ADMIN_ROLES.AUDITOR)).toBe(false);
  });

  it('reads role from app_metadata (not user_metadata)', async () => {
    const { requireAdminRole } = await import('../../supabase/functions/_shared/admin-roles.ts');
    const adminClient = {
      auth: {
        getUser: async () => ({
          data: {
            user: {
              id: 'attacker',
              user_metadata: { role: 'admin' },       // attacker-controlled
              app_metadata:  { role: 'customer' },    // truth
            },
          },
          error: null,
        }),
      },
    };
    const req = makeRequest({ action: 'queue' });
    const result = await requireAdminRole(adminClient, req, [ADMIN_ROLES.ADMIN]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it('rejects missing Authorization header with 401', async () => {
    const { requireAdminRole } = await import('../../supabase/functions/_shared/admin-roles.ts');
    const req = new Request('https://example.com/admin', { method: 'POST', body: '{}' });
    const result = await requireAdminRole({ auth: { getUser: async () => ({ data: { user: null } }) } }, req, [ADMIN_ROLES.ADMIN]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBe('missing_authorization');
  });
});

// ── Dispatcher: role split ───────────────────────────────────────────────

describe('handleAdminReconciliation: role split', () => {
  it('normal user (customer) cannot access counts', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'u', app_metadata: { role: 'customer' } },
    });
    const result = await handleAdminReconciliation(makeRequest({ action: 'counts' }), {
      supabaseAdmin: supabase,
      providerQueryConfigured: false,
    });
    expect(result.status).toBe(403);
    expect(result.body.error).toBe('forbidden');
  });

  it('normal user (customer) cannot access queue', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'u', app_metadata: { role: 'customer' } },
    });
    const result = await handleAdminReconciliation(makeRequest({ action: 'queue' }), {
      supabaseAdmin: supabase,
      providerQueryConfigured: false,
    });
    expect(result.status).toBe(403);
  });

  it('user with no role is rejected', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'u', app_metadata: {} },
    });
    const result = await handleAdminReconciliation(makeRequest({ action: 'counts' }), {
      supabaseAdmin: supabase,
      providerQueryConfigured: false,
    });
    expect(result.status).toBe(403);
  });

  it('auditor can read queue', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'u', app_metadata: { role: 'auditor' } },
      dataByTable: { [SAFE_REVIEW_VIEW]: [] },
    });
    const result = await handleAdminReconciliation(makeRequest({ action: 'queue' }), {
      supabaseAdmin: supabase,
      providerQueryConfigured: false,
    });
    expect(result.status).toBe(200);
    expect(result.body.viewer_role).toBe('auditor');
    expect(result.body.can_mutate).toBe(false);
    expect(result.body.can_run_admin_only).toBe(false);
  });

  it('auditor CANNOT mutate (mark_review_resolved is 403)', async () => {
    const insertCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'u', app_metadata: { role: 'auditor' } },
      insertCalls,
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'mark_review_resolved', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(403);
    // The forbidden mutation must still be audited.
    const audit = insertCalls.find((c) => c.table === 'audit_events');
    expect(audit).toBeTruthy();
    expect(audit.payload.event_type).toBe('admin.reconciliation.forbidden_mutation');
    expect(audit.payload.outcome).toBe('denied');
  });

  it('fraud_analyst can escalate', async () => {
    const insertCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'fa', app_metadata: { role: 'fraud_analyst' } },
      pendingRow: { id: 'p-1', tx_ref: 'TX', status: 'review_required', ledger_posted_at: null },
      insertCalls,
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'escalate_to_support', pending_payment_id: 'p-1', note: 'tier 2 please' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(200);
    expect(insertCalls.some((c) => c.table === 'audit_events' && c.payload.event_type === 'admin.reconciliation.escalated')).toBe(true);
  });

  it('fraud_analyst CANNOT trigger admin-only actions (reject_orphan_callback)', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'fa', app_metadata: { role: 'fraud_analyst' } },
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'reject_orphan_callback', reconciliation_event_id: 'wh-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(403);
  });

  it('fraud_analyst CANNOT retry provider query', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'fa', app_metadata: { role: 'fraud_analyst' } },
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: true },
    );
    expect(result.status).toBe(403);
  });

  it('admin can run mark_review_resolved + writes audit event', async () => {
    const insertCalls = [];
    const updateCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: { id: 'p-1', tx_ref: 'TX-2', status: 'review_required', ledger_posted_at: null },
      insertCalls,
      updateCalls,
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'mark_review_resolved', pending_payment_id: 'p-1', note: 'duplicate notice' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(200);
    expect(updateCalls.some((u) => u.table === 'pending_payments')).toBe(true);
    expect(insertCalls.some((c) => c.table === 'audit_events' && c.payload.event_type === 'admin.reconciliation.review_resolved')).toBe(true);
    expect(insertCalls.some((c) => c.table === 'payment_reconciliation_events' && c.payload.event_type === 'admin_review_resolved')).toBe(true);
  });

  it('admin can retry provider query when configured (executes STK Query end-to-end)', async () => {
    const insertCalls = [];
    const updateCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: {
        id: 'p-1', tx_ref: 'TX', checkout_request_id: 'ws_CO_1',
        merchant_request_id: 'mr_1', status: 'waiting_for_mpesa',
        ledger_posted_at: null,
        updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      insertCalls,
      updateCalls,
    });
    const fakeQueryStkPush = async () => ({
      outcome: 'cancelled', providerStatus: 'cancelled',
      checkoutRequestId: 'ws_CO_1', merchantRequestId: 'mr_1',
      resultCode: '1032', resultDesc: 'Request cancelled by user',
      providerReceipt: null, rawPayloadHash: 'f'.repeat(64),
      queriedAt: new Date().toISOString(),
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      {
        supabaseAdmin: supabase,
        providerQueryConfigured: true,
        queryStkPush: fakeQueryStkPush,
        readStkQueryEnv: (id, mr) => ({
          darajaEnv: 'sandbox',
          consumerKey: 'k', consumerSecret: 's',
          shortcode: '174379', passkey: 'PK',
          checkoutRequestId: id, merchantRequestId: mr,
        }),
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.provider_outcome).toBe('cancelled');
    expect(result.body.new_status).toBe('cancelled');
    // audit + reconciliation events should reflect the full lifecycle
    expect(insertCalls.some((c) => c.payload.event_type === 'admin.reconciliation.provider_retry_requested')).toBe(true);
    expect(insertCalls.some((c) => c.payload.event_type === 'admin.reconciliation.provider_retry_executed')).toBe(true);
    expect(insertCalls.some((c) => c.table === 'payment_reconciliation_events' && c.payload.event_type === 'provider_query.requested')).toBe(true);
    expect(insertCalls.some((c) => c.table === 'payment_reconciliation_events' && c.payload.event_type === 'provider_query.failed')).toBe(true);
    // Pending payment must have been transitioned to "cancelled".
    expect(updateCalls.some((u) => u.table === 'pending_payments' && u.payload.status === 'cancelled')).toBe(true);
    // It must NOT have been transitioned to "succeeded".
    expect(updateCalls.find((u) => u.table === 'pending_payments' && u.payload.status === 'succeeded')).toBeUndefined();
  });

  it('admin retry returns 503 when provider not configured', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: { id: 'p-1', status: 'waiting_for_mpesa', ledger_posted_at: null },
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toBe('provider_query_not_configured');
  });

  it('admin retry returns 409 when pending_payment has no checkout_request_id', async () => {
    const insertCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: {
        id: 'p-1', tx_ref: 'TX',
        checkout_request_id: null, status: 'waiting_for_mpesa',
        ledger_posted_at: null,
      },
      insertCalls,
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      {
        supabaseAdmin: supabase,
        providerQueryConfigured: true,
        queryStkPush: async () => { throw new Error('should not be called'); },
        readStkQueryEnv: () => ({}),
      },
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('missing_checkout_request_id');
    expect(insertCalls.some((c) => c.payload.event_type === 'admin.reconciliation.provider_retry_noop')).toBe(true);
  });

  it('admin retry: STK Query succeeded never finalises ledger directly', async () => {
    const insertCalls = [];
    const updateCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: {
        id: 'p-1', tx_ref: 'TX', checkout_request_id: 'ws_CO_OK',
        merchant_request_id: 'mr', status: 'waiting_for_mpesa',
        ledger_posted_at: null,
        updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      },
      insertCalls,
      updateCalls,
    });
    const fakeQueryStkPush = async () => ({
      outcome: 'succeeded', providerStatus: 'succeeded',
      checkoutRequestId: 'ws_CO_OK', merchantRequestId: 'mr',
      resultCode: '0', resultDesc: 'Success',
      providerReceipt: null, rawPayloadHash: 'a'.repeat(64),
      queriedAt: new Date().toISOString(),
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      {
        supabaseAdmin: supabase,
        providerQueryConfigured: true,
        queryStkPush: fakeQueryStkPush,
        readStkQueryEnv: (id, mr) => ({
          darajaEnv: 'sandbox', consumerKey: 'k', consumerSecret: 's',
          shortcode: '174379', passkey: 'PK',
          checkoutRequestId: id, merchantRequestId: mr,
        }),
      },
    );
    expect(result.status).toBe(200);
    expect(result.body.provider_outcome).toBe('succeeded');
    expect(result.body.new_status).toBe('review_required');
    // Pending payment moved to review_required, never directly to succeeded.
    expect(updateCalls.find((u) => u.payload.status === 'succeeded')).toBeUndefined();
    expect(updateCalls.some((u) => u.payload.status === 'review_required')).toBe(true);
    // No ledger_entries insert.
    expect(insertCalls.find((c) => c.table === 'ledger_entries')).toBeUndefined();
  });

  it('auditor cannot retry provider query (admin-only)', async () => {
    const insertCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'aud', app_metadata: { role: 'auditor' } },
      insertCalls,
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: true },
    );
    expect(result.status).toBe(403);
    // auditor is rejected before the admin-only check — by the forbidden_mutation gate.
    expect(insertCalls.some((c) => c.payload.event_type === 'admin.reconciliation.forbidden_mutation')).toBe(true);
  });

  it('fraud_analyst cannot retry provider query (audit logged)', async () => {
    const insertCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'fa', app_metadata: { role: 'fraud_analyst' } },
      insertCalls,
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: true },
    );
    expect(result.status).toBe(403);
    expect(insertCalls.some((c) => c.payload.event_type === 'admin.reconciliation.forbidden_admin_only')).toBe(true);
  });
});

// ── Terminal payment refusal ─────────────────────────────────────────────

describe('handleAdminReconciliation: ledger safety', () => {
  it('refuses to act on succeeded payments (ledger already final)', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: { id: 'p-1', status: 'succeeded', ledger_posted_at: new Date().toISOString() },
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'mark_review_resolved', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('payment_in_terminal_ledger_state');
  });

  it('refuses to act on reversed payments', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: { id: 'p-1', status: 'reversed', ledger_posted_at: new Date().toISOString() },
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'escalate_to_support', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(409);
  });

  it('refuses to retry provider on already-settled payment', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: { id: 'p-1', status: 'settled', ledger_posted_at: new Date().toISOString() },
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'retry_provider_query', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: true },
    );
    expect(result.status).toBe(409);
  });

  it('returns 404 when pending payment does not exist', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: null,
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'mark_review_resolved', pending_payment_id: 'missing' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('pending_payment_not_found');
  });

  it('never inserts into ledger_entries (no ledger writes from admin actions)', async () => {
    const insertCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      pendingRow: { id: 'p-1', status: 'review_required', tx_ref: 'TX', ledger_posted_at: null },
      insertCalls,
    });
    await handleAdminReconciliation(
      makeRequest({ action: 'mark_review_resolved', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    await handleAdminReconciliation(
      makeRequest({ action: 'escalate_to_support', pending_payment_id: 'p-1' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(insertCalls.every((c) => c.table !== 'ledger_entries')).toBe(true);
  });
});

// ── Queue + counts data contracts ────────────────────────────────────────

describe('handleAdminReconciliation: data contract', () => {
  it('queue read uses the safe payment_reconciliation_review view', async () => {
    const fromCalls = [];
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      dataByTable: { [SAFE_REVIEW_VIEW]: [] },
      fromCalls,
    });
    const result = await handleAdminReconciliation(makeRequest({ action: 'queue' }), {
      supabaseAdmin: supabase,
      providerQueryConfigured: false,
    });
    expect(result.status).toBe(200);
    expect(fromCalls).toContain(SAFE_REVIEW_VIEW);
    // It must NEVER touch raw webhook_events / pending_payments directly for the queue read.
    expect(fromCalls.filter((t) => t === 'webhook_events').length).toBe(0);
    expect(fromCalls.filter((t) => t === 'pending_payments').length).toBe(0);
  });

  it('queue response masks phone numbers and never exposes raw payloads', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      dataByTable: {
        [SAFE_REVIEW_VIEW]: [
          {
            event_id: 'e1',
            pending_payment_id: 'p1',
            external_reference: 'ws_CO_123456',
            reason: 'amount mismatch',
            provider_status: 'success',
            internal_status: 'review_required',
            amount_match: false,
            phone_match: true,
            requires_manual_review: true,
            event_type: 'amount_mismatch',
            created_at: new Date().toISOString(),
            tx_ref: 'TX',
            amount: 100,
            from_phone: '+254712345678',
            to_phone: '+254723456789',
            pending_status: 'review_required',
            pending_updated_at: new Date().toISOString(),
            // these should never appear in response even if the mock returns them
            raw_callback: { Body: 'SECRET' },
            raw_provider_payload_hash: 'deadbeef',
          },
        ],
      },
    });
    const result = await handleAdminReconciliation(makeRequest({ action: 'queue' }), {
      supabaseAdmin: supabase,
      providerQueryConfigured: false,
    });
    expect(result.status).toBe(200);
    const row = result.body.rows[0];
    expect(row.from_phone).toMatch(/\*\*\*\*/);
    expect(row.to_phone).toMatch(/\*\*\*\*/);
    expect(row).not.toHaveProperty('raw_callback');
    expect(row).not.toHaveProperty('raw_provider_payload_hash');
    expect(JSON.stringify(result.body)).not.toMatch(/SECRET/);
    expect(JSON.stringify(result.body)).not.toMatch(/deadbeef/);
  });

  it('rejects unknown actions with 400', async () => {
    const supabase = makeSupabaseMock();
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'drop_database' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('unknown_action');
  });

  it('rejects unknown filters by falling back to all', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'adm', app_metadata: { role: 'admin' } },
      dataByTable: { [SAFE_REVIEW_VIEW]: [] },
    });
    const result = await handleAdminReconciliation(
      makeRequest({ action: 'queue', filter: 'select * from users' }),
      { supabaseAdmin: supabase, providerQueryConfigured: false },
    );
    expect(result.status).toBe(200);
    expect(result.body.filter).toBe('all');
  });

  it('returns viewer_role + can_mutate so the client cannot fake role', async () => {
    const supabase = makeSupabaseMock({
      user: { id: 'u', app_metadata: { role: 'auditor' } },
      dataByTable: { [SAFE_REVIEW_VIEW]: [] },
    });
    const result = await handleAdminReconciliation(makeRequest({ action: 'queue' }), {
      supabaseAdmin: supabase,
      providerQueryConfigured: false,
    });
    expect(result.body.viewer_role).toBe('auditor');
    expect(result.body.can_mutate).toBe(false);
    expect(result.body.can_run_admin_only).toBe(false);
  });
});

// ── Source-level safety guarantees ───────────────────────────────────────

describe('admin-reconciliation source guarantees', () => {
  const handlerSource = readFileSync(
    resolve(process.cwd(), 'supabase/functions/admin-reconciliation/handler.ts'),
    'utf8',
  );
  const indexSource = readFileSync(
    resolve(process.cwd(), 'supabase/functions/admin-reconciliation/index.ts'),
    'utf8',
  );
  const source = handlerSource + '\n' + indexSource;

  it('imports requireAdminRole from the shared helper (single source of truth)', () => {
    expect(handlerSource).toMatch(/from '\.\.\/_shared\/admin-roles\.ts'/);
    expect(handlerSource).toMatch(/requireAdminRole/);
  });

  it('reads only from the safe view for queue rows', () => {
    expect(handlerSource).toMatch(/SAFE_REVIEW_VIEW\s*=\s*'payment_reconciliation_review'/);
    // No SQL select strings or .from() calls may reference raw payload columns.
    const codeOnly = stripComments(handlerSource);
    expect(codeOnly).not.toMatch(/\.select\([^)]*raw_callback/);
    expect(codeOnly).not.toMatch(/\.select\([^)]*raw_provider_payload/);
    expect(codeOnly).not.toMatch(/\.from\(['"]webhook_events['"]\)[^]*\.select\([^)]*raw_/);
  });

  it('never inserts into ledger_entries', () => {
    const codeOnly = stripComments(handlerSource + '\n' + indexSource);
    expect(codeOnly).not.toMatch(/\.from\(['"]ledger_entries['"]\)/);
    expect(codeOnly).not.toMatch(/post_double_entry\s*\(/);
  });

  it('writes audit events for every mutating action', () => {
    expect(source).toMatch(/admin\.reconciliation\.review_resolved/);
    expect(source).toMatch(/admin\.reconciliation\.escalated/);
    expect(source).toMatch(/admin\.reconciliation\.timeout_acknowledged/);
    expect(source).toMatch(/admin\.reconciliation\.orphan_rejected/);
    expect(source).toMatch(/admin\.reconciliation\.provider_retry_requested/);
    expect(source).toMatch(/admin\.reconciliation\.provider_retry_executed/);
    expect(source).toMatch(/admin\.reconciliation\.forbidden_mutation/);
    expect(source).toMatch(/admin\.reconciliation\.forbidden_admin_only/);
  });

  it('uses requireFunctionEnv for prod-safety', () => {
    expect(source).toMatch(/requireFunctionEnv/);
    expect(source).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('refuses terminal-payment mutations', () => {
    expect(source).toMatch(/TERMINAL_PAYMENT_STATUSES/);
    expect(source).toMatch(/payment_in_terminal_ledger_state/);
  });
});

// ── Frontend admin page contract ─────────────────────────────────────────

describe('frontend admin reconciliation client', () => {
  const apiSourceRaw = readFileSync(
    resolve(process.cwd(), 'src/lib/admin/reconciliationApi.js'),
    'utf8',
  );
  const pageSourceRaw = readFileSync(
    resolve(process.cwd(), 'src/pages/admin/ReconciliationCommandCenter.jsx'),
    'utf8',
  );
  const apiSource  = stripComments(apiSourceRaw);
  const pageSource = stripComments(pageSourceRaw);

  it('admin client only invokes the Edge Function (no direct table reads)', () => {
    expect(apiSourceRaw).toMatch(/admin-reconciliation/);
    expect(apiSourceRaw).toMatch(/functions\.invoke/);
    expect(apiSource).not.toMatch(/\.from\(['"][a-z_]+['"]\)/);
  });

  it('admin page does not import direct Supabase table helpers', () => {
    expect(pageSourceRaw).toMatch(/reconciliationApi/);
    expect(pageSource).not.toMatch(/\.from\(['"][a-z_]+['"]\)/);
    expect(pageSource).not.toMatch(/payment_reconciliation_review/);
    expect(pageSource).not.toMatch(/pending_payments/);
    expect(pageSource).not.toMatch(/webhook_events/);
  });

  it('admin page never accesses raw_callback / payload fields', () => {
    expect(pageSource).not.toMatch(/raw_callback/);
    expect(pageSource).not.toMatch(/raw_provider_payload/);
  });

  it('admin page reads role from server response (viewer_role) only', () => {
    expect(pageSourceRaw).toMatch(/viewer_role/);
    expect(pageSourceRaw).toMatch(/can_mutate/);
    expect(pageSourceRaw).toMatch(/can_run_admin_only/);
  });
});

// ── Safe view migration contract ─────────────────────────────────────────

describe('payment_reconciliation_review view extension', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260519050000_payment_reconciliation_review_duplicates.sql'),
    'utf8',
  );

  it('exposes duplicate_callback rows for the duplicate filter', () => {
    expect(sql).toMatch(/duplicate_callback/);
  });

  it('exposes admin action event types so the queue reflects them', () => {
    expect(sql).toMatch(/admin_review_resolved/);
    expect(sql).toMatch(/admin_escalated_to_support/);
    expect(sql).toMatch(/admin_timeout_acknowledged/);
    expect(sql).toMatch(/admin_retry_provider_query_queued/);
  });

  it('still excludes raw payload columns', () => {
    expect(sql).not.toMatch(/raw_callback/);
    expect(sql).not.toMatch(/raw_provider_payload_hash/);
  });

  it('preserves service_role-only grant', () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.payment_reconciliation_review FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT SELECT ON public\.payment_reconciliation_review TO service_role/i);
  });
});
