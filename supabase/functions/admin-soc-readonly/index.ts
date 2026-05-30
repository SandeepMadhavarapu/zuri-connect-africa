/**
 * admin-soc-readonly — Edge Function
 *
 * Purpose : Read-only aggregation backend for the 12 production admin panels
 *           (6 strategic in AdminSecurityDashboard + 6 incident-response in
 *           SecurityOperationsCenter). Returns a single structured JSON snapshot
 *           with per-panel aggregate objects.
 * Input   : POST { panels?: string[] }  — optional filter; if omitted, returns
 *           all panels accessible to the caller's role.
 * Output  : { generated_at, caller_role, panels: { panel_1_system_health, ... } }
 * Auth    : Bearer JWT required + app_metadata.role ∈ {admin, auditor,
 *           fraud_analyst, operator}. 401/403 otherwise.
 * Security: All DB queries use service_role (RLS bypass for admin aggregations).
 *           Role is read exclusively from app_metadata — never user_metadata.
 *           Panel 9 (device trust, contains PII) is restricted to admin + auditor.
 * Caching : Cache-Control: max-age=15 (15-second client cache; ops teams poll often).
 * Rate    : 60 req/min per caller.
 * Errors  : Individual panel query failures return null for that panel (partial
 *           degradation). A failed panel does not fail the whole response.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';
import { z } from 'npm:zod';
import { requireAdminRole } from '../_shared/admin-roles.ts';
import { checkRateLimit } from '../_shared/rate-limit.ts';

const APP_ORIGIN = Deno.env.get('APP_ORIGIN') ?? '';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin':  APP_ORIGIN || 'null',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(
  body: Record<string, unknown>,
  status = 200,
  extra?: Record<string, string>,
): Response {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders, ...extra },
  });
}

// ── Panel catalogue ──────────────────────────────────────────────────────────

const PANEL_KEYS: Record<number, string> = {
  1:  'panel_1_system_health',
  2:  'panel_2_webhook_health_24h',
  3:  'panel_3_risk_trend_24h',
  4:  'panel_4_payment_flow',
  5:  'panel_5_scam_signals',
  6:  'panel_6_provider_health',
  7:  'panel_7_live_audit',
  8:  'panel_8_manual_review_queue',
  9:  'panel_9_device_trust',
  10: 'panel_10_webhook_failures',
  11: 'panel_11_reconciliation_runs',
  12: 'panel_12_wrong_number_queue',
};

// Role → panel numbers the caller is permitted to receive.
// panel_9_device_trust contains device fingerprint hashes (PII) — restricted to
// admin + auditor only.  fraud_analyst and operator are intentionally excluded.
const ROLE_PANEL_ACCESS: Record<string, number[]> = {
  admin:         [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  auditor:       [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  fraud_analyst: [3, 5, 7, 12],
  operator:      [1, 2, 4, 8, 10, 11],
};

// ── Request schema ──────────────────────────────────────────────────────────

const requestSchema = z.object({
  panels: z.array(z.string()).optional(),
});

// ── Partial-degradation wrapper ─────────────────────────────────────────────

async function safePanel<T>(
  panelKey: string,
  userId: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(JSON.stringify({
      ts:         new Date().toISOString(),
      fn:         'admin-soc-readonly',
      evt:        'panel_query_failed',
      panel:      panelKey,
      user_id:    userId,
      error_code: (err as Record<string, unknown>)?.code ?? 'unknown',
    }));
    return null;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

  // Service role client used for all DB queries — bypasses RLS for admin
  // aggregations.  Caller's role is verified via JWT before any query runs.
  const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── Auth ────────────────────────────────────────────────────────────────────
  const auth = await requireAdminRole(
    supabaseAdmin,
    req,
    ['admin', 'auditor', 'fraud_analyst', 'operator'],
  );
  if (!auth.ok) {
    return json({ error: auth.error }, auth.status);
  }
  const userId = auth.user.id;
  const role   = auth.role;

  // ── Rate limit ───────────────────────────────────────────────────────────────
  const rl = await checkRateLimit(
    supabaseAdmin,
    userId,
    'user',
    'admin-soc-readonly',
    60,
    60,
  );
  if (!rl.allowed) {
    return json({ error: 'rate_limited' }, 429);
  }

  const startTime = Date.now();

  // ── Parse optional panel filter ─────────────────────────────────────────────
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    rawBody = {};
  }
  const parsed          = requestSchema.safeParse(rawBody);
  const requestedPanels = parsed.success ? (parsed.data.panels ?? null) : null;

  const allowedPanels = ROLE_PANEL_ACCESS[role] ?? [];

  function canAccess(panelNum: number): boolean {
    if (!allowedPanels.includes(panelNum)) return false;
    if (requestedPanels !== null && !requestedPanels.includes(PANEL_KEYS[panelNum])) return false;
    return true;
  }

  // ── Time windows ─────────────────────────────────────────────────────────────
  const now     = new Date();
  const h24ago  = new Date(now.getTime() -  24 * 60 * 60 * 1000).toISOString();
  const m10ago  = new Date(now.getTime() -  10 * 60 * 1000).toISOString();
  const d7ago   = new Date(now.getTime() -   7 * 24 * 60 * 60 * 1000).toISOString();

  // ── Panel queries (all run in parallel; each is independently fault-tolerant) ─

  const [
    p1, p2, p3, p4, p5, p6,
    p7, p8, p9, p10, p11, p12,
  ] = await Promise.all([

    // ── Panel 1 — System Health ───────────────────────────────────────────────
    canAccess(1)
      ? safePanel(PANEL_KEYS[1], userId, async () => {
          const [auditRes, webhookRes, reconRes] = await Promise.all([
            supabaseAdmin
              .from('audit_events')
              .select('id', { count: 'exact', head: true })
              .eq('severity', 'critical')
              .gte('created_at', h24ago),
            supabaseAdmin
              .from('webhook_events')
              .select('status')
              .gte('created_at', h24ago),
            supabaseAdmin
              .from('reconciliation_runs')
              .select('run_id, status, started_at, completed_at')
              .order('started_at', { ascending: false })
              .limit(1)
              .maybeSingle(),
          ]);
          const webhookRows    = (webhookRes.data ?? []) as Array<{ status: string }>;
          const webhookTotal   = webhookRows.length;
          const webhookSuccess = webhookRows.filter(
            (r) => r.status === 'processed' || r.status === 'success',
          ).length;
          return {
            audit_critical_24h:      auditRes.count ?? 0,
            webhook_success_rate_24h: webhookTotal > 0
              ? Math.round((webhookSuccess / webhookTotal) * 100)
              : null,
            last_reconciliation: reconRes.data ?? null,
          };
        })
      : Promise.resolve(null),

    // ── Panel 2 — Webhook Health (24h) ────────────────────────────────────────
    canAccess(2)
      ? safePanel(PANEL_KEYS[2], userId, async () => {
          const [webhookRes, nonceRes] = await Promise.all([
            supabaseAdmin
              .from('webhook_events')
              .select('status, created_at')
              .gte('created_at', h24ago),
            supabaseAdmin
              .from('webhook_nonces')
              .select('nonce, provider')
              .gte('received_at', h24ago),
          ]);
          const webhookRows = (webhookRes.data ?? []) as Array<{ status: string; created_at: string }>;

          // Group by hour
          const hourMap: Record<string, { hour_bucket: string; success: number; failed: number; ingested: number }> = {};
          for (const row of webhookRows) {
            const bucket = row.created_at.slice(0, 13) + ':00:00Z';
            if (!hourMap[bucket]) {
              hourMap[bucket] = { hour_bucket: bucket, success: 0, failed: 0, ingested: 0 };
            }
            hourMap[bucket].ingested++;
            if (row.status === 'processed' || row.status === 'success') {
              hourMap[bucket].success++;
            } else if (row.status === 'failed') {
              hourMap[bucket].failed++;
            }
          }
          const hourly_breakdown = Object.values(hourMap).sort(
            (a, b) => a.hour_bucket.localeCompare(b.hour_bucket),
          );

          // Detect replay attempts: nonce+provider combinations seen more than once
          const nonceRows  = (nonceRes.data ?? []) as Array<{ nonce: string; provider: string }>;
          const nonceCounts: Record<string, number> = {};
          for (const row of nonceRows) {
            const key = `${row.provider}:${row.nonce}`;
            nonceCounts[key] = (nonceCounts[key] ?? 0) + 1;
          }
          const replay_attempts = Object.values(nonceCounts)
            .filter((c) => c > 1)
            .reduce((sum, c) => sum + (c - 1), 0);

          return { hourly_breakdown, replay_attempts };
        })
      : Promise.resolve(null),

    // ── Panel 3 — Risk Engine Trend (24h) — operator excluded ────────────────
    canAccess(3)
      ? safePanel(PANEL_KEYS[3], userId, async () => {
          const { data: riskRows } = await supabaseAdmin
            .from('risk_decisions')
            .select('decision, risk_score, reasons, created_at')
            .gte('created_at', h24ago)
            .limit(2000);

          const rows        = (riskRows ?? []) as Array<{ decision: string; risk_score: number; reasons: string[]; created_at: string }>;
          const hourMap: Record<string, { hour_bucket: string; block: number; step_up: number; allow: number }> = {};
          const reasonMap:  Record<string, number> = {};
          let   totalScore  = 0;

          for (const row of rows) {
            const bucket = row.created_at.slice(0, 13) + ':00:00Z';
            if (!hourMap[bucket]) {
              hourMap[bucket] = { hour_bucket: bucket, block: 0, step_up: 0, allow: 0 };
            }
            const decision = row.decision ?? 'allow';
            if (decision === 'block') {
              hourMap[bucket].block++;
              const reasons = Array.isArray(row.reasons) ? row.reasons : [];
              for (const r of reasons) {
                if (typeof r === 'string') {
                  reasonMap[r] = (reasonMap[r] ?? 0) + 1;
                }
              }
            } else if (decision === 'step_up' || decision === 'manual_review') {
              hourMap[bucket].step_up++;
            } else {
              hourMap[bucket].allow++;
            }
            totalScore += Number(row.risk_score ?? 0);
          }

          const hourly = Object.values(hourMap).sort(
            (a, b) => a.hour_bucket.localeCompare(b.hour_bucket),
          );
          const avg_risk_score_24h = rows.length > 0
            ? Math.round(totalScore / rows.length)
            : null;
          const top_reasons = Object.entries(reasonMap)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5)
            .map(([reason_code, count]) => ({ reason_code, count }));

          return { hourly, avg_risk_score_24h, top_reasons };
        })
      : Promise.resolve(null),

    // ── Panel 4 — Payment Flow Health ─────────────────────────────────────────
    canAccess(4)
      ? safePanel(PANEL_KEYS[4], userId, async () => {
          const [staleRes, reviewRes] = await Promise.all([
            supabaseAdmin
              .from('pending_payments')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'pending')
              .lt('created_at', m10ago),
            supabaseAdmin
              .from('payment_reconciliation_events')
              .select('id', { count: 'exact', head: true })
              .eq('requires_manual_review', true),
          ]);
          return {
            stale_pending_count:  staleRes.count  ?? 0,
            manual_review_count:  reviewRes.count ?? 0,
          };
        })
      : Promise.resolve(null),

    // ── Panel 5 — Scam Shield Signals ─────────────────────────────────────────
    canAccess(5)
      ? safePanel(PANEL_KEYS[5], userId, async () => {
          const [authRes, simRes, critRes] = await Promise.all([
            supabaseAdmin
              .from('security_events')
              .select('id', { count: 'exact', head: true })
              .gte('created_at', h24ago),
            supabaseAdmin
              .from('security_events')
              .select('id', { count: 'exact', head: true })
              .like('event_type', 'sim_swap%')
              .gte('created_at', h24ago),
            supabaseAdmin
              .from('security_events')
              .select('id', { count: 'exact', head: true })
              .eq('severity', 'critical')
              .gte('created_at', h24ago),
          ]);
          return {
            auth_failures_24h:    authRes.count ?? 0,
            sim_swap_signals_24h: simRes.count  ?? 0,
            critical_24h:         critRes.count ?? 0,
          };
        })
      : Promise.resolve(null),

    // ── Panel 6 — Provider Directory Health ───────────────────────────────────
    canAccess(6)
      ? safePanel(PANEL_KEYS[6], userId, async () => {
          const [verRes, totalRes, reportRes] = await Promise.all([
            supabaseAdmin
              .from('provider_payment_methods')
              .select('id', { count: 'exact', head: true })
              .eq('verification_status', 'verified'),
            supabaseAdmin
              .from('provider_payment_methods')
              .select('id', { count: 'exact', head: true }),
            supabaseAdmin
              .from('provider_wrong_number_reports')
              .select('id', { count: 'exact', head: true })
              .eq('status', 'open'),
          ]);
          const verified_count   = verRes.count   ?? 0;
          const total            = totalRes.count  ?? 0;
          const unverified_count = total - verified_count;
          return {
            verified_count,
            unverified_count: unverified_count < 0 ? 0 : unverified_count,
            open_wrong_number_reports: reportRes.count ?? 0,
          };
        })
      : Promise.resolve(null),

    // ── Panel 7 — Live Audit Stream ────────────────────────────────────────────
    canAccess(7)
      ? safePanel(PANEL_KEYS[7], userId, async () => {
          const { data } = await supabaseAdmin
            .from('audit_events')
            .select('id, severity, event_category, event_type, actor_id, created_at')
            .order('created_at', { ascending: false })
            .limit(50);
          return data ?? [];
        })
      : Promise.resolve(null),

    // ── Panel 8 — Manual Review Queue ─────────────────────────────────────────
    canAccess(8)
      ? safePanel(PANEL_KEYS[8], userId, async () => {
          const { data } = await supabaseAdmin
            .from('payment_reconciliation_events')
            .select(
              'id, pending_payment_id, external_reference, provider_status, ' +
              'internal_status, amount_match, phone_match, requires_manual_review, created_at',
            )
            .eq('requires_manual_review', true)
            .order('created_at', { ascending: false })
            .limit(25);
          return data ?? [];
        })
      : Promise.resolve(null),

    // ── Panel 9 — Device Trust Registry — fraud_analyst + operator excluded ───
    canAccess(9)
      ? safePanel(PANEL_KEYS[9], userId, async () => {
          const { data } = await supabaseAdmin
            .from('trusted_devices')
            .select('id, user_id, device_label, trusted, revoked_at, last_seen_at')
            .order('last_seen_at', { ascending: false })
            .limit(25);
          return data ?? [];
        })
      : Promise.resolve(null),

    // ── Panel 10 — Webhook Failures & DLQ ────────────────────────────────────
    canAccess(10)
      ? safePanel(PANEL_KEYS[10], userId, async () => {
          const { data } = await supabaseAdmin
            .from('webhook_events')
            .select('id, source, idempotency_key, created_at')
            .eq('status', 'failed')
            .order('created_at', { ascending: false })
            .limit(25);
          return data ?? [];
        })
      : Promise.resolve(null),

    // ── Panel 11 — Reconciliation Runs ────────────────────────────────────────
    canAccess(11)
      ? safePanel(PANEL_KEYS[11], userId, async () => {
          const [runsRes, logsRes] = await Promise.all([
            supabaseAdmin
              .from('reconciliation_runs')
              .select(
                'run_id, run_type, status, orphan_debits, orphan_credits, ' +
                'started_at, completed_at',
              )
              .order('started_at', { ascending: false })
              .limit(10),
            supabaseAdmin
              .from('reconciliation_logs')
              .select('run_date, total_debits, total_credits, difference, status')
              .gte('run_date', d7ago)
              .order('run_date', { ascending: false }),
          ]);
          return {
            last_10_runs:            runsRes.data ?? [],
            daily_difference_trend:  logsRes.data ?? [],
          };
        })
      : Promise.resolve(null),

    // ── Panel 12 — Provider Wrong Number Reports ───────────────────────────────
    canAccess(12)
      ? safePanel(PANEL_KEYS[12], userId, async () => {
          const { data } = await supabaseAdmin
            .from('provider_wrong_number_reports')
            .select('id, payment_method_id, reporter_user_id, status, created_at')
            .in('status', ['open', 'investigating'])
            .order('created_at', { ascending: false })
            .limit(25);
          return data ?? [];
        })
      : Promise.resolve(null),
  ]);

  // ── Build response ────────────────────────────────────────────────────────────

  const panels = {
    panel_1_system_health:       p1,
    panel_2_webhook_health_24h:  p2,
    panel_3_risk_trend_24h:      p3,
    panel_4_payment_flow:        p4,
    panel_5_scam_signals:        p5,
    panel_6_provider_health:     p6,
    panel_7_live_audit:          p7,
    panel_8_manual_review_queue: p8,
    panel_9_device_trust:        p9,
    panel_10_webhook_failures:   p10,
    panel_11_reconciliation_runs: p11,
    panel_12_wrong_number_queue: p12,
  };

  const panelsReturned = Object.values(panels).filter((v) => v !== null).length;

  console.log(JSON.stringify({
    ts:               new Date().toISOString(),
    fn:               'admin-soc-readonly',
    evt:              'panels_fetched',
    user_id:          userId,
    role,
    panels_requested: requestedPanels ?? 'all',
    panels_returned:  panelsReturned,
    duration_ms:      Date.now() - startTime,
  }));

  return json(
    {
      generated_at: now.toISOString(),
      caller_role:  role,
      panels,
    },
    200,
    { 'Cache-Control': 'max-age=15' },
  );
});
