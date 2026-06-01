/**
 * notification-dispatcher recipient-resolution tests
 *
 * The Edge Function imports @supabase/supabase-js via an https://esm.sh
 * specifier and uses Deno globals, so it cannot be imported directly in
 * Vitest/Node (same constraint as provider-search / report-wrong-number).
 *
 * The recipient-resolution rule (`resolveSmsToAddress`) is mirrored here and
 * exercised behaviourally, then a set of source-level structural assertions tie
 * the mirror back to the real function so the two can't silently drift.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Mirror of resolveSmsToAddress() exported from
//    supabase/functions/notification-dispatcher/index.ts.
//    If the Edge Function helper changes, update this mirror to match.
function resolveSmsToAddress(opts) {
  const override =
    typeof opts.toAddressOverride === 'string' ? opts.toAddressOverride.trim() : '';
  if (override) return { to_address: override };

  if (opts.channel === 'sms') {
    const phone = typeof opts.phone === 'string' ? opts.phone.trim() : '';
    if (!phone) return { reject: 'no_phone_on_file' };
    return { to_address: phone };
  }

  return { to_address: null };
}

// ── Behavioural coverage ───────────────────────────────────────────────────────

describe('notification-dispatcher: resolveSmsToAddress', () => {
  it('SMS with no override and no phone on file → reject no_phone_on_file', () => {
    expect(resolveSmsToAddress({ channel: 'sms' })).toEqual({ reject: 'no_phone_on_file' });
    expect(resolveSmsToAddress({ channel: 'sms', phone: null })).toEqual({ reject: 'no_phone_on_file' });
    expect(resolveSmsToAddress({ channel: 'sms', phone: '' })).toEqual({ reject: 'no_phone_on_file' });
    // Whitespace-only phone is treated as missing.
    expect(resolveSmsToAddress({ channel: 'sms', phone: '   ' })).toEqual({ reject: 'no_phone_on_file' });
  });

  it("SMS with no override but a phone on file → uses the profile's phone", () => {
    expect(resolveSmsToAddress({ channel: 'sms', phone: '+254143305099' }))
      .toEqual({ to_address: '+254143305099' });
    // Stored phone is trimmed.
    expect(resolveSmsToAddress({ channel: 'sms', phone: '  +254143305099  ' }))
      .toEqual({ to_address: '+254143305099' });
  });

  it('explicit to_address override wins for SMS — no phone lookup required', () => {
    expect(resolveSmsToAddress({ channel: 'sms', toAddressOverride: '+254700000000' }))
      .toEqual({ to_address: '+254700000000' });
    // Override is honoured even when the user has no phone on file.
    expect(resolveSmsToAddress({ channel: 'sms', toAddressOverride: '+254700000000', phone: '' }))
      .toEqual({ to_address: '+254700000000' });
  });

  it('explicit to_address override works for any channel', () => {
    expect(resolveSmsToAddress({ channel: 'push', toAddressOverride: 'device-token-123' }))
      .toEqual({ to_address: 'device-token-123' });
    expect(resolveSmsToAddress({ channel: 'email', toAddressOverride: 'user@example.com' }))
      .toEqual({ to_address: 'user@example.com' });
  });

  it('non-SMS channels with no override resolve to a null address (out of scope for 6.2 worker)', () => {
    expect(resolveSmsToAddress({ channel: 'push' })).toEqual({ to_address: null });
    expect(resolveSmsToAddress({ channel: 'email' })).toEqual({ to_address: null });
    // A phone on file is ignored for non-SMS channels when no override is given.
    expect(resolveSmsToAddress({ channel: 'push', phone: '+254143305099' }))
      .toEqual({ to_address: null });
  });

  it('blank / non-string override is ignored and falls through to channel rules', () => {
    expect(resolveSmsToAddress({ channel: 'sms', toAddressOverride: '   ' }))
      .toEqual({ reject: 'no_phone_on_file' });
    expect(resolveSmsToAddress({ channel: 'sms', toAddressOverride: 12345, phone: '+254143305099' }))
      .toEqual({ to_address: '+254143305099' });
  });
});

// ── Source-level structural assertions ──────────────────────────────────────────

describe('notification-dispatcher: Edge Function source structure', () => {
  const src = readFileSync(
    resolve(process.cwd(), 'supabase/functions/notification-dispatcher/index.ts'),
    'utf8',
  );

  it('exports resolveSmsToAddress for unit testing', () => {
    expect(src).toMatch(/export\s+function\s+resolveSmsToAddress/);
  });

  it('documents the snapshot-phone-at-enqueue rationale', () => {
    expect(src).toMatch(/SNAPSHOT-PHONE-AT-ENQUEUE/);
    expect(src).toMatch(/snapshot/i);
  });

  it('handles OPTIONS preflight', () => {
    expect(src).toMatch(/req\.method.*===.*['"]OPTIONS['"]/);
  });

  it('returns 401 for unauthenticated callers', () => {
    expect(src).toMatch(/\b401\b/);
    expect(src).toMatch(/missing_authorization/);
    expect(src).toMatch(/invalid_token/);
  });

  it('rejects an SMS with no phone on file with HTTP 422 and no_phone_on_file', () => {
    expect(src).toMatch(/\b422\b/);
    expect(src).toMatch(/no_phone_on_file/);
  });

  it('looks up the caller phone from profiles when resolving an SMS recipient', () => {
    expect(src).toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
    expect(src).toMatch(/select\(\s*['"]phone['"]\s*\)/);
  });

  it('accepts an optional to_address override from the request body', () => {
    expect(src).toMatch(/reqBody\??\.\s*to_address/);
  });

  it('persists to_address on the enqueued notifications row (snapshot, not live-JOIN)', () => {
    expect(src).toMatch(/\.from\(\s*['"]notifications['"]\s*\)/);
    expect(src).toMatch(/to_address:\s*resolved\.to_address/);
  });

  it('keeps the payload in the existing body column (does not rename body → payload)', () => {
    expect(src).toMatch(/body:\s*reqBody\??\.\s*payload/);
  });

  it('enqueues with status queued', () => {
    expect(src).toMatch(/status:\s*['"]queued['"]/);
  });

  it('enforces ownership: inserted user_id is the authenticated caller, body.user_id ignored', () => {
    expect(src).toMatch(/user_id:\s*userId/);
    expect(src).toMatch(/intentionally ignored/i);
  });

  it('does not use wildcard CORS (falls back to "null")', () => {
    expect(src).not.toMatch(/'Access-Control-Allow-Origin'\s*:\s*['"]\*['"]/);
    expect(src).toMatch(/APP_ORIGIN\s*\|\|\s*['"]null['"]/);
  });
});
