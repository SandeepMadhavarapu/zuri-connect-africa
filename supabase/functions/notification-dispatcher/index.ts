// notification-dispatcher — enqueue-only producer for the notification queue.
//
// SNAPSHOT-PHONE-AT-ENQUEUE RATIONALE
// ───────────────────────────────────
// For SMS notifications we resolve and persist the recipient phone number
// ONTO the notifications row at enqueue time (the `to_address` column), rather
// than letting the downstream worker live-JOIN profiles.phone when it sends.
// This is a deliberate security/correctness choice:
//
//   * Snapshot, not live-JOIN. The address a message was queued against is the
//     address it gets delivered to. If a user later changes (or an attacker
//     manages to mutate) profiles.phone, queued messages do NOT silently
//     redirect to the new number — a sensitive receipt/OTP-style alert can't be
//     re-pointed at a different handset after the fact.
//   * No unsendable rows. If the user has no phone on file we reject the
//     dispatch up front (HTTP 422) instead of enqueuing a row the worker can
//     never deliver and would just churn on.
//   * The worker stays simple and side-effect-light: it reads `to_address`
//     off the row and sends. It never needs read access to profiles.
//
// An OPTIONAL `to_address` override is accepted in the request body so future
// admin tooling can dispatch to an arbitrary number. When omitted for an SMS we
// fall back to the authenticated caller's profiles.phone. Push/email channels
// are out of scope for the Phase 6.2 worker, so `to_address` may be null for
// non-SMS channels.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

/**
 * Resolve the recipient address to snapshot onto the notification row.
 *
 * Pure + side-effect free so it can be unit-tested in isolation (see
 * tests/unit/notification-dispatcher.test.js, which mirrors this logic).
 *
 *   * An explicit `toAddressOverride` always wins, for any channel.
 *   * SMS with no override requires a non-empty `phone`; otherwise the dispatch
 *     is rejected with `no_phone_on_file`.
 *   * Non-SMS channels (push/email/…) may resolve to a null address for now.
 */
export function resolveSmsToAddress(opts: {
  channel: string;
  toAddressOverride?: unknown;
  phone?: unknown;
}): { to_address: string | null } | { reject: 'no_phone_on_file' } {
  const override =
    typeof opts.toAddressOverride === 'string' ? opts.toAddressOverride.trim() : '';
  if (override) return { to_address: override };

  if (opts.channel === 'sms') {
    const phone = typeof opts.phone === 'string' ? opts.phone.trim() : '';
    if (!phone) return { reject: 'no_phone_on_file' };
    return { to_address: phone };
  }

  // push / email and other future channels: no address required yet.
  return { to_address: null };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  const url        = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const supabase   = createClient(url, serviceKey);

  // Require a valid Supabase JWT — unauthenticated callers cannot enqueue notifications.
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return Response.json({ error: 'missing_authorization' }, { status: 401, headers: corsHeaders });
  }
  const { data: userRes, error: authErr } = await supabase.auth.getUser(jwt);
  if (authErr || !userRes.user) {
    return Response.json({ error: 'invalid_token' }, { status: 401, headers: corsHeaders });
  }
  // Enforce ownership: user_id in the inserted row is always the authenticated caller's id.
  // The body's user_id field is intentionally ignored to prevent cross-user notification injection.
  const userId = userRes.user.id;

  try {
    const reqBody = await req.json();
    const channel  = typeof reqBody?.channel === 'string' ? reqBody.channel : 'push';
    const override = typeof reqBody?.to_address === 'string' ? reqBody.to_address.trim() : '';

    // Snapshot the recipient phone at enqueue time for SMS (see header rationale).
    // Only hit the DB when we actually need it: no override AND an SMS channel.
    let phone: string | undefined;
    if (!override && channel === 'sms') {
      const { data: profile, error: profileErr } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', userId)
        .maybeSingle();
      if (profileErr) {
        console.error('notification-dispatcher profile_lookup_failed', profileErr);
        return Response.json({ ok: false, error: 'profile_lookup_failed' }, { status: 500, headers: corsHeaders });
      }
      phone = profile?.phone ?? undefined;
    }

    const resolved = resolveSmsToAddress({ channel, toAddressOverride: override, phone });
    if ('reject' in resolved) {
      // Don't silently enqueue an unsendable SMS.
      return Response.json({ error: resolved.reject }, { status: 422, headers: corsHeaders });
    }

    await supabase.from('notifications').insert({
      user_id:    userId,
      channel,
      body:       reqBody?.payload ?? {},
      status:     'queued',
      to_address: resolved.to_address,
    });

    return Response.json({ ok: true, dispatched: true }, { headers: corsHeaders });
  } catch (e) {
    console.error('notification-dispatcher', e);
    return Response.json({ ok: false, error: String(e) }, { status: 500, headers: corsHeaders });
  }
});
