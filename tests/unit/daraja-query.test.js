import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildStkQueryRequestBody,
  darajaQueryBaseUrl,
  hashRawPayload,
  mapStkQueryOutcome,
  queryStkPush,
  readStkQueryEnv,
  sanitizeResultDesc,
} from '../../supabase/functions/_shared/daraja-query.ts';

import {
  applyProviderQueryResult,
} from '../../supabase/functions/_shared/provider-status-applier.ts';

// ── URL gating ────────────────────────────────────────────────────────────

describe('darajaQueryBaseUrl', () => {
  it('uses sandbox URL for sandbox', () => {
    expect(darajaQueryBaseUrl('sandbox')).toBe('https://sandbox.safaricom.co.ke');
  });
  it('uses sandbox URL for local', () => {
    expect(darajaQueryBaseUrl('local')).toBe('https://sandbox.safaricom.co.ke');
  });
  it('uses sandbox URL for demo', () => {
    expect(darajaQueryBaseUrl('demo')).toBe('https://sandbox.safaricom.co.ke');
  });
  it('uses sandbox URL when env is missing/unknown (fail closed away from prod)', () => {
    expect(darajaQueryBaseUrl('')).toBe('https://sandbox.safaricom.co.ke');
    expect(darajaQueryBaseUrl(undefined)).toBe('https://sandbox.safaricom.co.ke');
    expect(darajaQueryBaseUrl('garbage')).toBe('https://sandbox.safaricom.co.ke');
  });
  it('uses production URL ONLY when env is exactly "production"', () => {
    expect(darajaQueryBaseUrl('production')).toBe('https://api.safaricom.co.ke');
    expect(darajaQueryBaseUrl('PRODUCTION')).toBe('https://api.safaricom.co.ke');
    expect(darajaQueryBaseUrl(' Production ')).not.toBe('https://api.safaricom.co.ke');
  });
});

// ── Password generation ──────────────────────────────────────────────────

describe('buildStkQueryRequestBody', () => {
  it('generates BusinessShortCode + base64(Password) over shortcode+passkey+timestamp', () => {
    const req = buildStkQueryRequestBody({
      shortcode: '174379',
      passkey:   'PASSKEY',
      checkoutRequestId: 'ws_CO_19022019103645123',
      timestamp: '20260519120000',
    });
    expect(req.BusinessShortCode).toBe('174379');
    expect(req.Timestamp).toBe('20260519120000');
    // The password is btoa("174379" + "PASSKEY" + "20260519120000")
    const expected = Buffer.from('174379PASSKEY20260519120000', 'utf8').toString('base64');
    expect(req.Password).toBe(expected);
    expect(req.CheckoutRequestID).toBe('ws_CO_19022019103645123');
  });

  it('falls back to a fresh timestamp when caller passes a malformed one', () => {
    const req = buildStkQueryRequestBody({
      shortcode: '1', passkey: 'p', checkoutRequestId: 'c',
      timestamp: 'NOT-A-TIMESTAMP',
    });
    expect(req.Timestamp).toMatch(/^\d{14}$/);
  });
});

// ── Status mapping ────────────────────────────────────────────────────────

describe('mapStkQueryOutcome', () => {
  it('"0" => succeeded', () => {
    expect(mapStkQueryOutcome('0', 'OK')).toBe('succeeded');
  });
  it('"1032" => cancelled', () => {
    expect(mapStkQueryOutcome('1032', 'Request cancelled by user')).toBe('cancelled');
  });
  it('"1037" or "timed out" desc => timeout', () => {
    expect(mapStkQueryOutcome('1037', 'DS timeout user cannot be reached')).toBe('timeout');
    expect(mapStkQueryOutcome('999', 'Operation timed out')).toBe('timeout');
  });
  it('"1" + "processing" desc => still_pending', () => {
    expect(mapStkQueryOutcome('1', 'The transaction is being processed')).toBe('still_pending');
  });
  it('failure phrases => failed', () => {
    expect(mapStkQueryOutcome('2001', 'Wrong PIN entered')).toBe('failed');
    expect(mapStkQueryOutcome('1', 'Insufficient funds')).toBe('failed');
  });
  it('missing code => still_pending (server is still computing)', () => {
    expect(mapStkQueryOutcome('', '')).toBe('still_pending');
    expect(mapStkQueryOutcome('null', '')).toBe('still_pending');
  });
  it('anything we do not recognise => provider_unknown', () => {
    expect(mapStkQueryOutcome('9999', 'Mystery code from Daraja')).toBe('provider_unknown');
  });
});

// ── sanitizeResultDesc ────────────────────────────────────────────────────

describe('sanitizeResultDesc', () => {
  it('strips control characters', () => {
    expect(sanitizeResultDesc('Hello\u0000\u0007World')).toBe('Hello World');
  });
  it('truncates to 240 chars', () => {
    const long = 'x'.repeat(500);
    const out = sanitizeResultDesc(long);
    expect(out.length).toBe(240);
    expect(out.endsWith('...')).toBe(true);
  });
  it('coerces non-string safely', () => {
    expect(sanitizeResultDesc(undefined)).toBe('');
    expect(sanitizeResultDesc(null)).toBe('');
    expect(sanitizeResultDesc({})).toBe('[object Object]');
  });
});

// ── hashRawPayload ────────────────────────────────────────────────────────

describe('hashRawPayload', () => {
  it('returns a deterministic 64-char hex string', async () => {
    const a = await hashRawPayload({ a: 1, b: 'two' });
    const b = await hashRawPayload({ a: 1, b: 'two' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('different payloads produce different hashes', async () => {
    const a = await hashRawPayload({ a: 1 });
    const b = await hashRawPayload({ a: 2 });
    expect(a).not.toBe(b);
  });
});

// ── queryStkPush: secrets, URLs, no-leak logging ─────────────────────────

function mkResp(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('queryStkPush', () => {
  let logs;
  beforeEach(() => {
    logs = [];
    vi.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.map(String).join(' ')));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hits the sandbox host when env != production', async () => {
    const captured = { url: '', headers: null, body: '' };
    const fetchImpl = vi.fn(async (url, init) => {
      captured.url = url;
      captured.headers = init?.headers;
      captured.body = init?.body;
      return mkResp(200, { ResultCode: '0', ResultDesc: 'Success', CheckoutRequestID: 'ws_CO_1' });
    });
    const out = await queryStkPush(
      {
        darajaEnv: 'sandbox',
        consumerKey: 'k', consumerSecret: 's',
        shortcode: '174379', passkey: 'PK',
        checkoutRequestId: 'ws_CO_1',
      },
      { fetchImpl, getToken: async () => 'ACCESS-TOKEN-NEVER-LOG-ME' },
    );
    expect(out.outcome).toBe('succeeded');
    expect(captured.url).toBe('https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query');
  });

  it('hits the production host ONLY when DARAJA_ENV=production', async () => {
    const captured = { url: '' };
    const fetchImpl = vi.fn(async (url) => {
      captured.url = url;
      return mkResp(200, { ResultCode: '0', ResultDesc: 'Success' });
    });
    await queryStkPush(
      {
        darajaEnv: 'production',
        consumerKey: 'k', consumerSecret: 's',
        shortcode: '174379', passkey: 'PK',
        checkoutRequestId: 'ws_CO_2',
      },
      { fetchImpl, getToken: async () => 't' },
    );
    expect(captured.url).toBe('https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query');
  });

  it('returns provider_error when Daraja secrets are missing', async () => {
    const out = await queryStkPush(
      { darajaEnv: 'sandbox', consumerKey: '', consumerSecret: '', shortcode: '', passkey: '', checkoutRequestId: 'c' },
      { fetchImpl: vi.fn(), getToken: vi.fn() },
    );
    expect(out.outcome).toBe('provider_error');
    expect(out.resultDesc).toBe('daraja_secrets_missing');
  });

  it('returns provider_error and never logs the token on OAuth failure', async () => {
    const out = await queryStkPush(
      {
        darajaEnv: 'sandbox',
        consumerKey: 'k', consumerSecret: 'TOPSECRET-CONSUMER',
        shortcode: 's', passkey: 'PASSKEY-TOPSECRET',
        checkoutRequestId: 'ws_CO_1',
      },
      { getToken: async () => { throw new Error('boom-detail-with-token-info'); }, fetchImpl: vi.fn() },
    );
    expect(out.outcome).toBe('provider_error');
    const joined = logs.join('\n');
    expect(joined).not.toMatch(/TOPSECRET-CONSUMER/);
    expect(joined).not.toMatch(/PASSKEY-TOPSECRET/);
    expect(joined).not.toMatch(/Bearer\s+\S+/);
    expect(joined).not.toMatch(/boom-detail-with-token-info/);
  });

  it('never logs the access token, password, or Authorization header', async () => {
    const fetchImpl = vi.fn(async () => mkResp(500, { errorMessage: 'something else' }));
    await queryStkPush(
      {
        darajaEnv: 'sandbox',
        consumerKey: 'k', consumerSecret: 's',
        shortcode: '174379', passkey: 'PASSKEY-VERY-SECRET',
        checkoutRequestId: 'ws_CO_1',
      },
      { fetchImpl, getToken: async () => 'ACCESS-TOKEN-DO-NOT-LOG' },
    );
    const joined = logs.join('\n');
    expect(joined).not.toMatch(/ACCESS-TOKEN-DO-NOT-LOG/);
    expect(joined).not.toMatch(/PASSKEY-VERY-SECRET/);
    expect(joined).not.toMatch(/Bearer\s+ACCESS/);
  });

  it('reads "transaction is being processed" 500 errors as still_pending', async () => {
    const fetchImpl = vi.fn(async () => mkResp(500, { errorMessage: 'The transaction is being processed' }));
    const out = await queryStkPush(
      {
        darajaEnv: 'sandbox',
        consumerKey: 'k', consumerSecret: 's',
        shortcode: '174379', passkey: 'p',
        checkoutRequestId: 'ws_CO_1',
      },
      { fetchImpl, getToken: async () => 't' },
    );
    expect(out.outcome).toBe('still_pending');
  });

  it('falls back to provider_error on other non-200 responses', async () => {
    const fetchImpl = vi.fn(async () => mkResp(503, { errorMessage: 'Service unavailable' }));
    const out = await queryStkPush(
      {
        darajaEnv: 'sandbox',
        consumerKey: 'k', consumerSecret: 's',
        shortcode: '174379', passkey: 'p',
        checkoutRequestId: 'ws_CO_1',
      },
      { fetchImpl, getToken: async () => 't' },
    );
    expect(out.outcome).toBe('provider_error');
  });

  it('parses canonical Daraja success body', async () => {
    const fetchImpl = vi.fn(async () => mkResp(200, {
      ResultCode: '0',
      ResultDesc: 'The service request is processed successfully.',
      CheckoutRequestID: 'ws_CO_OK',
      MerchantRequestID: '12345-67890-12',
    }));
    const out = await queryStkPush(
      {
        darajaEnv: 'sandbox',
        consumerKey: 'k', consumerSecret: 's',
        shortcode: '174379', passkey: 'p',
        checkoutRequestId: 'ws_CO_OK',
      },
      { fetchImpl, getToken: async () => 't' },
    );
    expect(out.outcome).toBe('succeeded');
    expect(out.checkoutRequestId).toBe('ws_CO_OK');
    expect(out.merchantRequestId).toBe('12345-67890-12');
    expect(out.rawPayloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.providerReceipt).toBeNull();
  });

  it('parses canonical Daraja cancellation body', async () => {
    const fetchImpl = vi.fn(async () => mkResp(200, {
      ResultCode: '1032',
      ResultDesc: 'Request cancelled by user',
      CheckoutRequestID: 'ws_CO_X',
    }));
    const out = await queryStkPush(
      {
        darajaEnv: 'sandbox',
        consumerKey: 'k', consumerSecret: 's',
        shortcode: '174379', passkey: 'p',
        checkoutRequestId: 'ws_CO_X',
      },
      { fetchImpl, getToken: async () => 't' },
    );
    expect(out.outcome).toBe('cancelled');
  });
});

// ── readStkQueryEnv ───────────────────────────────────────────────────────

describe('readStkQueryEnv', () => {
  const KEYS = ['DARAJA_CONSUMER_KEY', 'DARAJA_CONSUMER_SECRET', 'DARAJA_SHORTCODE', 'DARAJA_PASSKEY', 'DARAJA_ENV'];
  const baseline = {};
  beforeEach(() => {
    for (const k of KEYS) {
      baseline[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (baseline[k] === undefined) delete process.env[k];
      else                            process.env[k] = baseline[k];
    }
  });

  it('returns null when any secret is missing', () => {
    process.env.DARAJA_CONSUMER_KEY    = 'k';
    process.env.DARAJA_CONSUMER_SECRET = 's';
    process.env.DARAJA_SHORTCODE       = '174379';
    expect(readStkQueryEnv('ws_CO_1')).toBeNull();
  });

  it('returns input when all secrets present', () => {
    process.env.DARAJA_CONSUMER_KEY    = 'k';
    process.env.DARAJA_CONSUMER_SECRET = 's';
    process.env.DARAJA_SHORTCODE       = '174379';
    process.env.DARAJA_PASSKEY         = 'PK';
    process.env.DARAJA_ENV             = 'sandbox';
    const inp = readStkQueryEnv('ws_CO_1', 'mr_1');
    expect(inp).toMatchObject({
      darajaEnv: 'sandbox',
      consumerKey: 'k', consumerSecret: 's',
      shortcode: '174379', passkey: 'PK',
      checkoutRequestId: 'ws_CO_1', merchantRequestId: 'mr_1',
    });
  });
});

// ── applyProviderQueryResult ──────────────────────────────────────────────

function recorderDeps() {
  const updates = [];
  const events  = [];
  const audits  = [];
  return {
    deps: {
      updatePendingPayment: async (id, patch) => { updates.push({ id, patch }); },
      recordEvent:          async (e) => { events.push(e); },
      writeAuditEvent:      async (a) => { audits.push(a); },
    },
    updates, events, audits,
  };
}

function pending(overrides = {}) {
  return {
    id: 'p-1',
    tx_ref: 'TX-1',
    user_id: 'u-1',
    status: 'waiting_for_mpesa',
    amount: 100,
    from_phone: '+254712345678',
    to_phone: '+254723456789',
    checkout_request_id: 'ws_CO_1',
    merchant_request_id: 'mr_1',
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ledger_posted_at: null,
    ...overrides,
  };
}

function fakeQuery(outcome, overrides = {}) {
  return {
    outcome,
    providerStatus: outcome,
    checkoutRequestId: 'ws_CO_1',
    merchantRequestId: 'mr_1',
    resultCode: outcome === 'succeeded' ? '0' : '1',
    resultDesc: `provider says ${outcome}`,
    providerReceipt: null,
    rawPayloadHash: 'a'.repeat(64),
    queriedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('applyProviderQueryResult: ledger safety', () => {
  it('never posts ledger from succeeded — routes to review_required', async () => {
    const r = recorderDeps();
    const report = await applyProviderQueryResult(
      pending(),
      fakeQuery('succeeded'),
      r.deps,
      { reviewAfterMinutes: 120, trigger: 'reconciliation_sweep' },
    );
    expect(report.newStatus).toBe('review_required');
    expect(report.action).toBe('transitioned_review_required');
    expect(r.updates.some((u) => u.patch.status === 'review_required')).toBe(true);
    expect(r.events.some((e) => e.event_type === 'provider_query.succeeded')).toBe(true);
    expect(r.events.some((e) => e.event_type === 'provider_query.manual_review_required')).toBe(true);
    // Must not transition to 'succeeded' state.
    expect(r.updates.find((u) => u.patch.status === 'succeeded')).toBeUndefined();
  });

  it('refuses to touch a ledger-posted payment (succeeded outcome)', async () => {
    const r = recorderDeps();
    const report = await applyProviderQueryResult(
      pending({ ledger_posted_at: new Date().toISOString(), status: 'succeeded' }),
      fakeQuery('succeeded'),
      r.deps,
      { reviewAfterMinutes: 120, trigger: 'reconciliation_sweep' },
    );
    expect(report.action).toBe('noop_ledger_posted');
    expect(r.updates).toHaveLength(0);
  });

  it('does NOT auto-reverse a ledger-posted payment on late failure', async () => {
    const r = recorderDeps();
    const report = await applyProviderQueryResult(
      pending({ ledger_posted_at: new Date().toISOString(), status: 'succeeded' }),
      fakeQuery('failed'),
      r.deps,
      { reviewAfterMinutes: 120, trigger: 'reconciliation_sweep' },
    );
    expect(report.action).toBe('noop_ledger_posted');
    expect(r.updates).toHaveLength(0);
    expect(r.audits.some((a) => a.event_type === 'reconciliation.provider_query.noop_ledger_posted')).toBe(true);
  });

  it('does NOT post a ledger for failed/cancelled/timeout outcomes', async () => {
    for (const outcome of ['failed', 'cancelled', 'timeout']) {
      const r = recorderDeps();
      await applyProviderQueryResult(pending(), fakeQuery(outcome), r.deps, {
        reviewAfterMinutes: 120, trigger: 'reconciliation_sweep',
      });
      expect(r.updates.find((u) => u.patch.status === 'succeeded')).toBeUndefined();
      expect(r.updates.find((u) => u.patch.status === outcome)).toBeDefined();
    }
  });

  it('leaves still_pending alone when within the review window', async () => {
    const r = recorderDeps();
    const report = await applyProviderQueryResult(
      pending({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
      fakeQuery('still_pending'),
      r.deps,
      { reviewAfterMinutes: 120, trigger: 'reconciliation_sweep' },
    );
    expect(report.action).toBe('noop_still_pending');
    expect(r.updates).toHaveLength(0);
    expect(r.events.some((e) => e.event_type === 'provider_query.still_pending')).toBe(true);
  });

  it('escalates still_pending past the review threshold', async () => {
    const r = recorderDeps();
    const report = await applyProviderQueryResult(
      pending({ updated_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString() }),
      fakeQuery('still_pending'),
      r.deps,
      { reviewAfterMinutes: 120, trigger: 'reconciliation_sweep' },
    );
    expect(report.action).toBe('transitioned_review_required');
    expect(r.events.some((e) => e.event_type === 'provider_query.manual_review_required')).toBe(true);
  });

  it('treats provider_unknown/error as no-op within review window (sweep mode)', async () => {
    for (const outcome of ['provider_unknown', 'provider_error']) {
      const r = recorderDeps();
      const report = await applyProviderQueryResult(
        pending({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
        fakeQuery(outcome),
        r.deps,
        { reviewAfterMinutes: 120, trigger: 'reconciliation_sweep' },
      );
      expect(report.action).toBe('noop_still_pending');
      expect(r.updates).toHaveLength(0);
    }
  });

  it('admin retry escalates provider_unknown/error immediately', async () => {
    for (const outcome of ['provider_unknown', 'provider_error']) {
      const r = recorderDeps();
      const report = await applyProviderQueryResult(
        pending({ updated_at: new Date(Date.now() - 10 * 60_000).toISOString() }),
        fakeQuery(outcome),
        r.deps,
        { reviewAfterMinutes: 120, trigger: 'admin_retry', escalateInconclusiveImmediately: true },
      );
      expect(report.action).toBe('transitioned_review_required');
      expect(r.events.some((e) => e.event_type === 'provider_query.manual_review_required')).toBe(true);
    }
  });

  it('flags late success after terminal failure for human review (no ledger reversal)', async () => {
    const r = recorderDeps();
    const report = await applyProviderQueryResult(
      pending({ status: 'failed' }),
      fakeQuery('succeeded'),
      r.deps,
      { reviewAfterMinutes: 120, trigger: 'reconciliation_sweep' },
    );
    expect(report.action).toBe('noop_already_terminal');
    expect(r.updates).toHaveLength(0);
    expect(r.audits.some((a) => a.event_type === 'reconciliation.provider_query.late_success_after_terminal')).toBe(true);
  });
});

// ── Source-level guarantees ───────────────────────────────────────────────

describe('source: secret-safety + no ledger write', () => {
  const querySrc = readFileSync(
    resolve(process.cwd(), 'supabase/functions/_shared/daraja-query.ts'),
    'utf8',
  );
  const applierSrc = readFileSync(
    resolve(process.cwd(), 'supabase/functions/_shared/provider-status-applier.ts'),
    'utf8',
  );

  it('daraja-query never console.logs the token, password, or Authorization header', () => {
    expect(querySrc).not.toMatch(/console\.(log|info|warn|error)\([^)]*token/i);
    expect(querySrc).not.toMatch(/console\.(log|info|warn|error)\([^)]*password/i);
    expect(querySrc).not.toMatch(/console\.(log|info|warn|error)\([^)]*passkey/i);
    expect(querySrc).not.toMatch(/console\.(log|info|warn|error)\([^)]*authorization/i);
    expect(querySrc).not.toMatch(/console\.(log|info|warn|error)\([^)]*consumer.{0,4}secret/i);
  });

  it('daraja-query never logs the raw Daraja body verbatim', () => {
    // We allow `data.errorMessage` to be passed through `sanitizeResultDesc`
    // but not the whole `data` object.
    expect(querySrc).not.toMatch(/console\.(log|info|warn|error)\([^)]*\bdata\b[^)]*\)/);
  });

  it('provider-status-applier never inserts into ledger_entries or calls post_double_entry', () => {
    expect(applierSrc).not.toMatch(/ledger_entries/);
    expect(applierSrc).not.toMatch(/post_double_entry/);
  });

  it('reconciliation-job wires the real STK Query via shared helpers', () => {
    const reconSrc = readFileSync(
      resolve(process.cwd(), 'supabase/functions/reconciliation-job/index.ts'),
      'utf8',
    );
    expect(reconSrc).toMatch(/queryStkPush/);
    expect(reconSrc).toMatch(/applyProviderQueryResult/);
    expect(reconSrc).toMatch(/readStkQueryEnv/);
  });

  it('admin-reconciliation retry_provider_query calls the real query helper', () => {
    const adminSrc = readFileSync(
      resolve(process.cwd(), 'supabase/functions/admin-reconciliation/handler.ts'),
      'utf8',
    );
    expect(adminSrc).toMatch(/queryStkPush/);
    expect(adminSrc).toMatch(/applyProviderQueryResult/);
    expect(adminSrc).toMatch(/admin\.reconciliation\.provider_retry_executed/);
    expect(adminSrc).toMatch(/admin\.reconciliation\.provider_retry_failed/);
    expect(adminSrc).toMatch(/admin\.reconciliation\.provider_retry_requested/);
  });

  it('frontend never imports Daraja query helpers', () => {
    const apiSrc = readFileSync(
      resolve(process.cwd(), 'src/lib/admin/reconciliationApi.js'),
      'utf8',
    );
    expect(apiSrc).not.toMatch(/daraja-query/);
    expect(apiSrc).not.toMatch(/DARAJA_/);
    expect(apiSrc).not.toMatch(/PASSKEY/);
  });
});
