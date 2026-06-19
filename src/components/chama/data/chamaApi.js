/**
 * Hesabu data layer — reuses the app's canonical Supabase access patterns.
 *
 *  - WRITES (create a group) go through the live `create-chama-group` Edge
 *    Function via `supabase.functions.invoke`, exactly like providerService /
 *    reconciliationApi do. The user's JWT is attached automatically by the
 *    browser client (Authorization header from the persisted session) — we
 *    never hand-roll fetch + auth headers, and we NEVER send a user id.
 *
 *  - READS (the user's chamas) use the browser client's `.from()` selects. The
 *    chama_* tables have RLS that grants SELECT to active members of a group
 *    (see 20260610120000_chama_core_schema.sql), so an authenticated user can
 *    read their own groups/members/cycles/obligations with the anon client.
 */

import { getSupabaseBrowserClient } from '@/lib/supabase/client.js';

/** Shared TanStack Query key so the dialog can invalidate the home list. */
export const MY_CHAMAS_QUERY_KEY = ['hesabu', 'my-chamas'];

/** First letter (uppercased) of a name/email, with a neutral fallback. */
function initialFor(value) {
  const s = String(value || '').trim();
  return s ? s[0].toUpperCase() : '•';
}

/**
 * Create a chama group via the live Edge Function.
 *
 * @param {{ name: string, description?: string, currency?: string }} input
 * @returns {Promise<object>} the created group ({ id, name, ... })
 * @throws {Error & { code?: string, status?: number }} on any failure, with the
 *   server's error code (NAME_INVALID, RATE_LIMITED, …) attached so the caller
 *   can show a friendly message. The SERVER remains the source of truth.
 */
export async function createChamaGroup({ name, description, currency }) {
  const supabase = getSupabaseBrowserClient();

  const { data, error } = await supabase.functions.invoke('create-chama-group', {
    // NEVER include a user id — identity is derived server-side from the JWT.
    body: { name, description, currency },
  });

  // Non-2xx: supabase-js sets `error` (FunctionsHttpError) and exposes the raw
  // Response on `error.context`. Read the JSON body to recover the error code.
  if (error) {
    const status = error?.context?.status;
    let code = null;
    try {
      const payload = await error.context.json();
      code = payload?.error ?? null;
    } catch {
      /* body wasn't JSON — fall back to status-based messaging */
    }
    const err = new Error(code || 'REQUEST_FAILED');
    err.code = code;
    err.status = status;
    throw err;
  }

  if (!data?.ok || !data.group) {
    const err = new Error(data?.error || 'REQUEST_FAILED');
    err.code = data?.error ?? null;
    throw err;
  }

  return data.group;
}

/**
 * Open a contribution cycle for a group via the live Edge Function.
 *
 * Mirrors createChamaGroup exactly: invoke `create-contribution-cycle` (JWT
 * auto-attached by the browser client — we NEVER send a user id), and on a
 * non-2xx recover the server's error code from `error.context.json()` so the
 * caller can show friendly copy. The SERVER remains the source of truth; amounts
 * are sent in KES and converted to cents server-side.
 *
 * @param {{ groupId: string, name: string, amountKes: number|string,
 *   dueDate: string, graceDays?: number }} input
 * @returns {Promise<{ cycle: object, obligationCount: number }>}
 * @throws {Error & { code?: string, status?: number }} on any failure.
 */
export async function createContributionCycle({ groupId, name, amountKes, dueDate, graceDays }) {
  const supabase = getSupabaseBrowserClient();

  const body = {
    group_id: groupId,
    name,
    amount_kes: Number(amountKes),
    due_date: dueDate,
  };
  // Only send grace_days when explicitly provided; otherwise the server default
  // (3) applies. The dialog does not expose this field yet.
  if (graceDays !== undefined && graceDays !== null) body.grace_days = graceDays;

  const { data, error } = await supabase.functions.invoke('create-contribution-cycle', {
    body,
  });

  // Non-2xx: supabase-js sets `error` (FunctionsHttpError) with the raw Response
  // on `error.context`. Read the JSON body to recover the error code.
  if (error) {
    const status = error?.context?.status;
    let code = null;
    try {
      const payload = await error.context.json();
      code = payload?.error ?? null;
    } catch {
      /* body wasn't JSON — fall back to status-based messaging */
    }
    const err = new Error(code || 'REQUEST_FAILED');
    err.code = code;
    err.status = status;
    throw err;
  }

  if (!data?.ok || !data.cycle) {
    const err = new Error(data?.error || 'REQUEST_FAILED');
    err.code = data?.error ?? null;
    throw err;
  }

  return { cycle: data.cycle, obligationCount: Number(data.obligation_count ?? 0) };
}

/**
 * Fetch the current user's chamas (groups they are an ACTIVE member of) and
 * shape each one for <ChamaListItem>. New groups have no cycle/obligations yet,
 * so pooled = 0, no next obligation, and hasActiveCycle = false — handled
 * gracefully, never thrown.
 *
 * @param {{ id: string, full_name?: string, email?: string }} currentUser
 * @returns {Promise<Array>} list of chama view-models
 */
export async function fetchMyChamas(currentUser) {
  const supabase = getSupabaseBrowserClient();
  const userId = currentUser?.id;
  if (!userId) return [];

  // 1. My active memberships, with the parent group embedded via the FK.
  const { data: memberships, error: mErr } = await supabase
    .from('chama_members')
    .select('id, group_id, role, status, chama_groups ( id, name, currency, status, created_at )')
    .eq('user_id', userId)
    .eq('status', 'active');
  if (mErr) throw mErr;
  if (!memberships || memberships.length === 0) return [];

  const groupIds = memberships.map((m) => m.group_id);

  // 2. Supporting data for the cards — counts, open cycles, obligations.
  //    All scoped to my groups; RLS allows reads as an active member.
  const [membersRes, cyclesRes, obligationsRes] = await Promise.all([
    supabase.from('chama_members').select('group_id, status').in('group_id', groupIds),
    supabase
      .from('chama_contribution_cycles')
      .select('id, group_id, due_at, status')
      .in('group_id', groupIds),
    supabase
      .from('chama_obligations')
      .select('id, group_id, member_id, cycle_id, amount_due_cents, status')
      .in('group_id', groupIds),
  ]);
  if (membersRes.error) throw membersRes.error;
  if (cyclesRes.error) throw cyclesRes.error;
  if (obligationsRes.error) throw obligationsRes.error;

  const allMembers = membersRes.data || [];
  const cycles = cyclesRes.data || [];
  const obligations = obligationsRes.data || [];

  const myMemberIdByGroup = new Map(memberships.map((m) => [m.group_id, m.id]));
  const myName = currentUser.full_name || currentUser.email || 'You';
  const myInitial = initialFor(myName);

  return memberships.map((m) => {
    const group = m.chama_groups || {};
    const gid = m.group_id;

    const membersTotal = allMembers.filter(
      (x) => x.group_id === gid && x.status === 'active',
    ).length;

    const groupObligations = obligations.filter((o) => o.group_id === gid);

    // Pooled = sum of SETTLED obligations (0 for a brand-new group).
    const pooledCents = groupObligations
      .filter((o) => o.status === 'settled')
      .reduce((sum, o) => sum + Number(o.amount_due_cents || 0), 0);

    // Current open cycle, if the group has started one.
    const openCycle = cycles.find((c) => c.group_id === gid && c.status === 'open') || null;

    const membersPaid = openCycle
      ? groupObligations.filter((o) => o.cycle_id === openCycle.id && o.status === 'settled').length
      : 0;

    // My next unsettled obligation in the open cycle (if any).
    let nextObligation = null;
    const myMemberId = myMemberIdByGroup.get(gid);
    if (openCycle && myMemberId) {
      const mine = groupObligations.find(
        (o) =>
          o.cycle_id === openCycle.id &&
          o.member_id === myMemberId &&
          (o.status === 'due' || o.status === 'pending_payment'),
      );
      if (mine) {
        nextObligation = {
          amountCents: Number(mine.amount_due_cents || 0),
          dueDate: openCycle.due_at,
          status: mine.status,
        };
      }
    }

    return {
      id: gid,
      name: group.name || 'Untitled chama',
      role: m.role || 'member',
      currency: group.currency || 'KES',
      pooledCents,
      membersTotal,
      membersPaid,
      // We can reliably attribute only the current user's name; other members'
      // names live behind a separate read path, so they roll up into the "+N".
      members: [{ name: myName, initial: myInitial }],
      nextObligation,
      hasActiveCycle: Boolean(openCycle),
    };
  });
}
