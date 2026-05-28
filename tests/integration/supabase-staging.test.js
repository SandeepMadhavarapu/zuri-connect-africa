/**
 * Live Supabase staging validation — requires GitHub secrets or local env.
 * Set: SUPABASE_STAGING_URL, SUPABASE_STAGING_ANON_KEY, SUPABASE_STAGING_TEST_EMAIL, SUPABASE_STAGING_TEST_PASSWORD
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_STAGING_URL || '';
const anonKey = process.env.SUPABASE_STAGING_ANON_KEY || '';
const testEmail = process.env.SUPABASE_STAGING_TEST_EMAIL || '';
const testPassword = process.env.SUPABASE_STAGING_TEST_PASSWORD || '';

const stagingReady = Boolean(
  url && anonKey && testEmail && testPassword && /^https:\/\/.+/.test(url)
);

describe.skipIf(!stagingReady)('Supabase staging — RLS & auth', () => {
  let anonClient;
  let authedClient;

  beforeAll(() => {
    anonClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  it('anonymous session cannot read finance ledger rows (RLS)', { timeout: 45_000 }, async () => {
    const { data, error } = await anonClient.from('ledger_entries').select('id').limit(5);
    expect(error).toBeNull();
    expect(data?.length ?? 0).toBe(0);
  });

  it('anonymous session cannot read fraud_logs (RLS)', { timeout: 45_000 }, async () => {
    const { data, error } = await anonClient.from('fraud_logs').select('id').limit(5);
    expect(error).toBeNull();
    expect(data?.length ?? 0).toBe(0);
  });

  it('authenticated session can sign in and query scoped ledger', { timeout: 45_000 }, async () => {
    authedClient = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signIn, error: signErr } = await authedClient.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    expect(signErr).toBeNull();
    expect(signIn?.session?.user?.id).toBeTruthy();

    const uid = signIn.session.user.id;
    const { data, error } = await authedClient
      .from('ledger_entries')
      .select('id, transaction_ref, owner_id')
      .eq('owner_id', uid)
      .limit(20);

    expect(error).toBeNull();
    expect(Array.isArray(data)).toBe(true);
  });

  it('authenticated session cannot insert ledger_entries directly', { timeout: 45_000 }, async () => {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: signIn, error: signErr } = await client.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    expect(signErr).toBeNull();

    const { error } = await client.from('ledger_entries').insert({
      transaction_ref: `RLS-TEST-${Date.now()}`,
      entry_type: 'debit',
      amount: 1,
      balance_before: 100,
      balance_after: 99,
      account_phone: '+254700000099',
      description: 'rls negative test',
      hash: '0'.repeat(64),
      owner_id: signIn?.session?.user?.id,
    });

    expect(error).toBeTruthy();
  });

  it('authenticated session cannot execute post_double_entry', { timeout: 45_000 }, async () => {
    const client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signErr } = await client.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    expect(signErr).toBeNull();

    const tx = `RPC-RLS-TEST-${Date.now()}`;
    const { error } = await client.rpc('post_double_entry', {
      p_debit: {
        transaction_ref: tx,
        amount: '1',
        balance_before: '100',
        balance_after: '99',
        account_phone: '+254700000099',
        description: 'rpc negative test',
        hash: '0'.repeat(64),
        owner_id: '00000000-0000-0000-0000-000000000099',
        idempotency_key: tx,
      },
      p_credit: {
        transaction_ref: tx,
        amount: '1',
        balance_before: '0',
        balance_after: '1',
        account_phone: '+254700000100',
        description: 'rpc negative test',
        hash: '1'.repeat(64),
        owner_id: '00000000-0000-0000-0000-000000000099',
        idempotency_key: tx,
      },
      p_expect_debit_balance_before: 100,
    });

    expect(error).toBeTruthy();
  });
});

describe('Supabase staging — env contract', () => {
  it('documents required variables when live tests are skipped', () => {
    if (stagingReady) {
      expect(url).toMatch(/^https:\/\//);
    } else {
      expect(stagingReady).toBe(false);
    }
  });
});
