import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveWebhookSkipFlags,
  areWebhookSkipFlagsAllowed,
  getAppEnv,
  getDarajaEnv,
  isDarajaQueryConfigured,
} from '../../supabase/functions/_shared/payment-env.ts';

import { sweepStuckPendingPayments } from '../../supabase/functions/_shared/stuck-payments.ts';

const ENV_KEYS = [
  'APP_ENV',
  'DARAJA_ENV',
  'WEBHOOK_SKIP_SIGNATURE',
  'WEBHOOK_SKIP_IP_CHECK',
  'DARAJA_CONSUMER_KEY',
  'DARAJA_CONSUMER_SECRET',
  'DARAJA_SHORTCODE',
  'DARAJA_PASSKEY',
];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else                       process.env[k] = snap[k];
  }
}

describe('payment-env: skip-flag gating', () => {
  let baseline;
  beforeEach(() => {
    baseline = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => restoreEnv(baseline));

  it('refuses skip flags when DARAJA_ENV=production', () => {
    process.env.DARAJA_ENV = 'production';
    process.env.WEBHOOK_SKIP_SIGNATURE = 'true';
    const state = resolveWebhookSkipFlags();
    expect(state.refusedInProduction).toBe(true);
    expect(state.skipSignatureEffective).toBe(false);
    expect(areWebhookSkipFlagsAllowed()).toBe(false);
    expect(getDarajaEnv()).toBe('production');
  });

  it('refuses skip flags when APP_ENV=production even if DARAJA_ENV=sandbox', () => {
    process.env.APP_ENV = 'production';
    process.env.DARAJA_ENV = 'sandbox';
    process.env.WEBHOOK_SKIP_IP_CHECK = 'true';
    const state = resolveWebhookSkipFlags();
    expect(state.refusedInProduction).toBe(true);
    expect(state.skipIpEffective).toBe(false);
    expect(areWebhookSkipFlagsAllowed()).toBe(false);
  });

  it('refuses skip flags when APP_ENV=staging', () => {
    process.env.APP_ENV = 'staging';
    process.env.WEBHOOK_SKIP_SIGNATURE = 'true';
    process.env.WEBHOOK_SKIP_IP_CHECK  = 'true';
    const state = resolveWebhookSkipFlags();
    expect(state.refusedInProduction).toBe(true);
    expect(state.skipSignatureEffective).toBe(false);
    expect(state.skipIpEffective).toBe(false);
  });

  it('refuses skip flags when env is completely unknown (fail closed)', () => {
    process.env.WEBHOOK_SKIP_SIGNATURE = 'true';
    const state = resolveWebhookSkipFlags();
    expect(state.refusedInProduction).toBe(true);
    expect(areWebhookSkipFlagsAllowed()).toBe(false);
  });

  it('allows skip flags only when explicitly set in sandbox', () => {
    process.env.DARAJA_ENV = 'sandbox';
    process.env.WEBHOOK_SKIP_SIGNATURE = 'true';
    const state = resolveWebhookSkipFlags();
    expect(state.refusedInProduction).toBe(false);
    expect(state.skipSignatureEffective).toBe(true);
    expect(getAppEnv()).toBe('unknown'); // unset is fine when DARAJA_ENV is sandbox
  });

  it('allows skip flags when APP_ENV=local', () => {
    process.env.APP_ENV = 'local';
    process.env.WEBHOOK_SKIP_IP_CHECK = 'true';
    const state = resolveWebhookSkipFlags();
    expect(state.refusedInProduction).toBe(false);
    expect(state.skipIpEffective).toBe(true);
  });

  it('does not flip flags when no skip requested', () => {
    process.env.DARAJA_ENV = 'production';
    const state = resolveWebhookSkipFlags();
    expect(state.refusedInProduction).toBe(false);
    expect(state.skipSignatureEffective).toBe(false);
    expect(state.skipIpEffective).toBe(false);
  });

  it('isDarajaQueryConfigured requires all four secrets', () => {
    expect(isDarajaQueryConfigured()).toBe(false);
    process.env.DARAJA_CONSUMER_KEY    = 'k';
    process.env.DARAJA_CONSUMER_SECRET = 's';
    process.env.DARAJA_SHORTCODE       = '174379';
    expect(isDarajaQueryConfigured()).toBe(false);
    process.env.DARAJA_PASSKEY         = 'p';
    expect(isDarajaQueryConfigured()).toBe(true);
  });
});

describe('webhook-handler source: skip-flag refusal wired in', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'supabase/functions/webhook-handler/index.ts'),
    'utf8',
  );

  it('imports resolveWebhookSkipFlags from shared payment-env', () => {
    expect(source).toMatch(/from '\.\.\/_shared\/payment-env\.ts'/);
    expect(source).toMatch(/resolveWebhookSkipFlags/);
  });

  it('refuses skip flags in production with explicit error code + audit event', () => {
    expect(source).toMatch(/SKIP_FLAGS_NOT_ALLOWED_IN_PRODUCTION/);
    expect(source).toMatch(/webhook\.skip_flag_refused/);
    expect(source).toMatch(/refusedInProduction/);
  });

  it('emits canonical security event names', () => {
    expect(source).toMatch(/webhook\.received/);
    expect(source).toMatch(/webhook\.duplicate/);
    expect(source).toMatch(/webhook\.orphan/);
  });

  it('documents callback verification strategy in code', () => {
    expect(source).toMatch(/verification strategy/i);
    expect(source).toMatch(/CheckoutRequestID/);
    expect(source).toMatch(/IP allowlist/i);
  });

  it('does not silently allow unknown callbacks (orphan path returns 404)', () => {
    expect(source).toMatch(/PENDING_PAYMENT_NOT_FOUND/);
    expect(source).toMatch(/event_type:\s*'webhook\.orphan'/);
  });
});

describe('payment-lifecycle: canonical security event names', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'supabase/functions/_shared/payment-lifecycle.ts'),
    'utf8',
  );

  it('amount/phone mismatch emits webhook.amount_mismatch or webhook.phone_mismatch', () => {
    expect(source).toMatch(/webhook\.amount_mismatch/);
    expect(source).toMatch(/webhook\.phone_mismatch/);
  });

  it('conflicting status emits webhook.conflicting_status', () => {
    expect(source).toMatch(/webhook\.conflicting_status/);
  });

  it('reconciliation events carry a human-readable reason', () => {
    expect(source).toMatch(/reason:\s*reasonFor\(eventType\)/);
  });
});

describe('payment_reconciliation_review migration', () => {
  const sql = readFileSync(
    resolve(process.cwd(), 'supabase/migrations/20260519040000_payment_reconciliation_review.sql'),
    'utf8',
  );

  it('adds reason column', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reason TEXT/);
  });

  it('defines payment_reconciliation_review view exposing only safe fields', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW public\.payment_reconciliation_review/i);
    expect(sql).toMatch(/external_reference/);
    expect(sql).toMatch(/requires_manual_review/);
    expect(sql).toMatch(/provider_status/);
    expect(sql).toMatch(/internal_status/);
    expect(sql).toMatch(/amount_match/);
    expect(sql).toMatch(/phone_match/);
    expect(sql).not.toMatch(/raw_callback/i);
    expect(sql).not.toMatch(/raw_provider_payload_hash/i);
  });

  it('locks down the view: revoke from anon/authenticated, grant only to service_role', () => {
    expect(sql).toMatch(/REVOKE ALL ON public\.payment_reconciliation_review FROM PUBLIC, anon, authenticated/i);
    expect(sql).toMatch(/GRANT SELECT ON public\.payment_reconciliation_review TO service_role/i);
  });
});

describe('sweepStuckPendingPayments', () => {
  function makeRow(overrides = {}) {
    return {
      id: 'p-1',
      tx_ref: 'TX-1',
      user_id: 'u-1',
      status: 'waiting_for_mpesa',
      amount: 100,
      from_phone: '+254712345678',
      to_phone: '+254723456789',
      checkout_request_id: 'ck-1',
      merchant_request_id: 'mr-1',
      updated_at: new Date(Date.now() - 31 * 60_000).toISOString(),
      ...overrides,
    };
  }

  it('marks stuck waiting_for_mpesa as timeout when provider channel absent', async () => {
    const markTimeout  = vi.fn().mockResolvedValue({});
    const markReview   = vi.fn().mockResolvedValue({});
    const recordEvent  = vi.fn().mockResolvedValue({});
    const writeAudit   = vi.fn().mockResolvedValue({});

    const report = await sweepStuckPendingPayments(
      {
        fetchStuck: async () => [makeRow()],
        markTimeout,
        markReview,
        recordEvent,
        writeAuditEvent: writeAudit,
        providerQueryConfigured: false,
      },
      { stuckAfterMinutes: 30, reviewAfterMinutes: 120 },
    );

    expect(report.timedOut).toBe(1);
    expect(report.flaggedForReview).toBe(0);
    expect(markTimeout).toHaveBeenCalledWith('p-1', expect.objectContaining({ status: 'timeout' }));
    expect(markReview).not.toHaveBeenCalled();
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'stuck_timeout',
      requires_manual_review: false,
    }));
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'reconciliation.timeout',
    }));
  });

  it('escalates payments older than reviewAfterMinutes to review_required', async () => {
    const markTimeout = vi.fn().mockResolvedValue({});
    const markReview  = vi.fn().mockResolvedValue({});
    const recordEvent = vi.fn().mockResolvedValue({});
    const writeAudit  = vi.fn().mockResolvedValue({});

    const oldRow = makeRow({
      updated_at: new Date(Date.now() - 4 * 60 * 60_000).toISOString(),
    });

    const report = await sweepStuckPendingPayments(
      {
        fetchStuck: async () => [oldRow],
        markTimeout,
        markReview,
        recordEvent,
        writeAuditEvent: writeAudit,
        providerQueryConfigured: false,
      },
      { stuckAfterMinutes: 30, reviewAfterMinutes: 120 },
    );

    expect(report.flaggedForReview).toBe(1);
    expect(markReview).toHaveBeenCalledWith('p-1', expect.objectContaining({ status: 'review_required' }));
    expect(markTimeout).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'reconciliation.review_required',
      severity:   'critical',
    }));
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'stuck_review_required',
      requires_manual_review: true,
    }));
  });

  it('flags review_required when provider query throws', async () => {
    const markTimeout = vi.fn().mockResolvedValue({});
    const markReview  = vi.fn().mockResolvedValue({});
    const recordEvent = vi.fn().mockResolvedValue({});
    const writeAudit  = vi.fn().mockResolvedValue({});

    const report = await sweepStuckPendingPayments(
      {
        fetchStuck: async () => [makeRow()],
        markTimeout,
        markReview,
        recordEvent,
        writeAuditEvent: writeAudit,
        providerQueryConfigured: true,
        queryProviderStatus: async () => { throw new Error('boom'); },
      },
      { stuckAfterMinutes: 30, reviewAfterMinutes: 120 },
    );

    expect(report.providerQueryFailed).toBe(1);
    expect(report.flaggedForReview).toBe(1);
    expect(markTimeout).not.toHaveBeenCalled();
    expect(markReview).toHaveBeenCalledWith('p-1', expect.objectContaining({ status: 'review_required' }));
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'reconciliation.provider_query_failed',
    }));
    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'provider_query_failed',
      requires_manual_review: true,
    }));
  });

  it('refuses to mutate rows already in terminal status', async () => {
    const markTimeout = vi.fn();
    const markReview  = vi.fn();
    const recordEvent = vi.fn();

    const report = await sweepStuckPendingPayments(
      {
        fetchStuck: async () => [makeRow({ status: 'succeeded' })],
        markTimeout,
        markReview,
        recordEvent,
        providerQueryConfigured: false,
      },
      { stuckAfterMinutes: 30, reviewAfterMinutes: 120 },
    );

    expect(report.timedOut).toBe(0);
    expect(report.flaggedForReview).toBe(0);
    expect(report.skippedAlreadyTerminal).toBe(1);
    expect(markTimeout).not.toHaveBeenCalled();
    expect(markReview).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it('never posts to the ledger or invents callback data', async () => {
    const markTimeout = vi.fn().mockResolvedValue({});
    const markReview  = vi.fn().mockResolvedValue({});
    const recordEvent = vi.fn().mockResolvedValue({});

    await sweepStuckPendingPayments(
      {
        fetchStuck: async () => [makeRow()],
        markTimeout,
        markReview,
        recordEvent,
        providerQueryConfigured: false,
      },
      { stuckAfterMinutes: 30, reviewAfterMinutes: 120 },
    );

    const eventArg = recordEvent.mock.calls[0][0];
    expect(eventArg.requires_manual_review).toBe(false);
    expect(eventArg.raw_provider_payload_hash).toBe('');
    expect(eventArg.amount_match).toBeNull();
    expect(eventArg.phone_match).toBeNull();

    const updateArg = markTimeout.mock.calls[0][1];
    expect(updateArg).not.toHaveProperty('ledger_posted_at');
    expect(updateArg).not.toHaveProperty('provider_receipt');
  });
});

describe('reconciliation-job source: wires sweep + audit', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'supabase/functions/reconciliation-job/index.ts'),
    'utf8',
  );

  it('calls sweepStuckPendingPayments', () => {
    expect(source).toMatch(/sweepStuckPendingPayments/);
  });

  it('reads RECONCILIATION_STUCK_AFTER_MINUTES and RECONCILIATION_REVIEW_AFTER_MINUTES', () => {
    expect(source).toMatch(/RECONCILIATION_STUCK_AFTER_MINUTES/);
    expect(source).toMatch(/RECONCILIATION_REVIEW_AFTER_MINUTES/);
  });

  it('queries pending_payments with only processing/waiting_for_mpesa statuses', () => {
    expect(source).toMatch(/processing.*waiting_for_mpesa|waiting_for_mpesa.*processing/);
  });

  it('uses isDarajaQueryConfigured to decide provider query availability', () => {
    expect(source).toMatch(/isDarajaQueryConfigured/);
  });
});
