/**
 * Admin Security Dashboard — SOC strategic overview (6 panels).
 * Data source: admin-soc-readonly Edge Function (Phase 5.2).
 * Role guard: fraud_analyst, admin, auditor, operator.
 */

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Lock, Info, AlertCircle } from 'lucide-react';
import { useAuth }               from '@/lib/AuthContext';
import { canViewFraudDashboard } from '@/lib/rbac';
import { fetchAdminSocSnapshot } from '@/services/adminSocService';

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function Dot({ level }) {
  const cls =
    level === 'green' ? 'bg-green-400' :
    level === 'amber' ? 'bg-amber-400' :
                        'bg-red-400';
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />;
}

// ── Panel shell ───────────────────────────────────────────────────────────────
// data === null      → role-restricted (show locked card)
// data === undefined → error / not loaded (show "No data")
// data === object    → render children

function PanelShell({ title, tooltip, data, children }) {
  if (data === null) {
    return (
      <div className="glass-card rounded-xl border border-white/6 px-4 py-3 flex items-center gap-2 min-h-[72px]">
        <Lock size={11} className="text-muted-foreground shrink-0" />
        <span className="text-[11px] text-muted-foreground">
          Restricted — admin or auditor required
        </span>
      </div>
    );
  }
  return (
    <div className="glass-card rounded-xl border border-white/6 p-4 flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground flex-1">
          {title}
        </p>
        {tooltip && (
          <Info
            size={10}
            className="text-muted-foreground/50 cursor-default shrink-0"
            title={tooltip}
          />
        )}
      </div>
      {data === undefined
        ? <p className="text-[11px] text-muted-foreground">No data</p>
        : children}
    </div>
  );
}

// ── Panel 1 — System Health ───────────────────────────────────────────────────

function Panel1({ data }) {
  const auditN = data?.audit_critical_24h       ?? 0;
  const rate   = data?.webhook_success_rate_24h;
  const recon  = data?.last_reconciliation;

  const auditLevel   = auditN === 0 ? 'green' : auditN < 5 ? 'amber' : 'red';
  const webhookLevel = rate == null ? 'amber' : rate >= 99 ? 'green' : rate >= 95 ? 'amber' : 'red';

  return (
    <PanelShell
      title="SYSTEM HEALTH"
      tooltip="Critical audit events, webhook success rate, and most recent reconciliation run (24h)."
      data={data}
    >
      <div className="space-y-1">
        <div className="flex items-center justify-between h-8">
          <span className="text-[11px] text-muted-foreground">Audit critical (24h)</span>
          <div className="flex items-center gap-2">
            <span className="font-grotesk font-bold text-xl text-foreground">{auditN}</span>
            <Dot level={auditLevel} />
          </div>
        </div>
        <div className="flex items-center justify-between h-8">
          <span className="text-[11px] text-muted-foreground">Webhook success rate (24h)</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-foreground">
              {rate != null ? `${rate}%` : '—'}
            </span>
            <Dot level={webhookLevel} />
          </div>
        </div>
        <div className="pt-1.5 border-t border-white/5 space-y-0.5">
          {recon ? (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground">Last reconciliation</span>
                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${
                  recon.status === 'completed'
                    ? 'text-green-400 border-green-400/25 bg-green-400/8'
                    : recon.status === 'running'
                    ? 'text-amber-400 border-amber-400/25 bg-amber-400/8'
                    : 'text-red-400 border-red-400/25 bg-red-400/8'
                }`}>{recon.status}</span>
              </div>
              <p className="font-mono text-[10px] text-muted-foreground truncate">{recon.run_id}</p>
              <p className="text-[10px] text-muted-foreground">{relativeTime(recon.started_at)}</p>
            </>
          ) : (
            <p className="text-[10px] text-muted-foreground">No reconciliation run recorded</p>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

// ── Panel 2 — Webhook Health ──────────────────────────────────────────────────

function Panel2({ data }) {
  const hours  = data?.hourly_breakdown ?? [];
  const replay = data?.replay_attempts  ?? 0;
  const maxN   = Math.max(1, ...hours.map((h) => h.ingested));

  return (
    <PanelShell
      title="WEBHOOK HEALTH (24H)"
      tooltip="Hourly webhook ingestion and success rate. Each bar = one hour. Green = 100%, amber = 95-99%, red < 95%."
      data={data}
    >
      {hours.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No webhook events in 24h</p>
      ) : (
        <div className="flex items-end gap-px h-8 rounded overflow-hidden">
          {hours.map((h, i) => {
            const heightPct  = Math.max(8, Math.round((h.ingested / maxN) * 100));
            const successRate = h.ingested > 0 ? (h.success / h.ingested) * 100 : 100;
            const barColor =
              successRate >= 100 ? 'bg-green-400/70' :
              successRate >= 95  ? 'bg-amber-400/70' :
                                   'bg-red-400/70';
            return (
              <div
                key={i}
                className={`flex-1 rounded-sm ${barColor}`}
                style={{ height: `${heightPct}%` }}
                title={`${h.hour_bucket?.slice(11, 13) ?? i}:00 — ${h.ingested} events, ${Math.round(successRate)}% success`}
              />
            );
          })}
        </div>
      )}
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>oldest → newest</span>
        <span>
          Replay attempts:{' '}
          <span className={replay > 0 ? 'text-amber-400 font-semibold' : 'text-foreground tabular-nums'}>
            {replay}
          </span>
        </span>
      </div>
    </PanelShell>
  );
}

// ── Panel 3 — Risk Engine Trend ───────────────────────────────────────────────

function Panel3({ data }) {
  const hours   = data?.hourly      ?? [];
  const avg     = data?.avg_risk_score_24h;
  const reasons = data?.top_reasons ?? [];

  const totals = hours.reduce(
    (acc, h) => ({
      block:   acc.block   + h.block,
      step_up: acc.step_up + h.step_up,
      allow:   acc.allow   + h.allow,
    }),
    { block: 0, step_up: 0, allow: 0 },
  );
  const totalN = totals.block + totals.step_up + totals.allow || 1;

  return (
    <PanelShell
      title="RISK ENGINE TREND (24H)"
      tooltip="Risk engine decisions over 24 hours. Block/Step-up/Allow counts and top block reason codes."
      data={data}
    >
      {/* Stacked proportion bar */}
      <div className="h-2 rounded-full overflow-hidden flex">
        <div
          className="bg-red-400/70"
          style={{ width: `${(totals.block / totalN) * 100}%` }}
          title={`Block: ${totals.block}`}
        />
        <div
          className="bg-amber-400/70"
          style={{ width: `${(totals.step_up / totalN) * 100}%` }}
          title={`Step-up: ${totals.step_up}`}
        />
        <div className="flex-1 bg-green-400/20" title={`Allow: ${totals.allow}`} />
      </div>

      {/* 3-column decision counts */}
      <div className="grid grid-cols-3 text-center gap-1">
        {[
          { label: 'Block',   value: totals.block,   color: 'text-red-400'   },
          { label: 'Step-up', value: totals.step_up, color: 'text-amber-400' },
          { label: 'Allow',   value: totals.allow,   color: 'text-green-400' },
        ].map(({ label, value, color }) => (
          <div key={label}>
            <p className={`font-grotesk font-bold text-lg ${color}`}>{value}</p>
            <p className="text-[9px] text-muted-foreground uppercase tracking-wide">{label}</p>
          </div>
        ))}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Avg risk score:{' '}
        <span className="font-mono text-foreground">{avg != null ? avg : '—'}</span>
      </p>

      {reasons.length > 0 && (
        <div className="space-y-1 border-t border-white/5 pt-1">
          {reasons.map((r) => (
            <div key={r.reason_code} className="flex items-center justify-between">
              <span className="font-mono text-[9px] text-muted-foreground">{r.reason_code}</span>
              <span className="text-[9px] text-foreground font-semibold tabular-nums">{r.count}</span>
            </div>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

// ── Panel 4 — Payment Flow Health ────────────────────────────────────────────

function Panel4({ data }) {
  const stale  = data?.stale_pending_count ?? 0;
  const review = data?.manual_review_count ?? 0;

  const staleLevel  = stale  === 0 ? 'green' : stale  < 10 ? 'amber' : 'red';
  const reviewLevel = review <  5  ? 'green' : review < 20 ? 'amber' : 'red';

  return (
    <PanelShell
      title="PAYMENT FLOW HEALTH"
      tooltip="Stale pending payments (>10 min without resolution) and manual review queue depth."
      data={data}
    >
      <div className="flex items-center justify-between h-10">
        <span className="text-[11px] text-muted-foreground">Stale pending</span>
        <div className="flex items-center gap-2">
          <span className="font-grotesk font-bold text-2xl text-foreground">{stale}</span>
          <Dot level={staleLevel} />
        </div>
      </div>
      <div className="flex items-center justify-between h-10">
        <span className="text-[11px] text-muted-foreground">Manual review queue</span>
        <div className="flex items-center gap-2">
          <span className="font-grotesk font-bold text-2xl text-foreground">{review}</span>
          <Dot level={reviewLevel} />
        </div>
      </div>
    </PanelShell>
  );
}

// ── Panel 5 — Scam Shield Signals ────────────────────────────────────────────

function Panel5({ data }) {
  const auth     = data?.auth_failures_24h    ?? 0;
  const simSwap  = data?.sim_swap_signals_24h ?? 0;
  const critical = data?.critical_24h         ?? 0;

  const stats = [
    { label: 'Auth failures', value: auth,     level: auth === 0 ? 'green' : auth < 10 ? 'amber' : 'red' },
    { label: 'SIM swap',      value: simSwap,  level: simSwap  === 0 ? 'green' : simSwap  < 3 ? 'amber' : 'red' },
    { label: 'Critical',      value: critical, level: critical === 0 ? 'green' : critical < 5 ? 'amber' : 'red' },
  ];

  return (
    <PanelShell
      title="SCAM SHIELD SIGNALS"
      tooltip="Auth failures, SIM-swap detections, and critical security events in the past 24 hours."
      data={data}
    >
      <div className="grid grid-cols-3 gap-2">
        {stats.map(({ label, value, level }) => (
          <div key={label} className="flex flex-col items-center gap-1 py-1">
            <div className="flex items-center gap-1">
              <span className="font-grotesk font-bold text-xl text-foreground">{value}</span>
              <Dot level={level} />
            </div>
            <span className="text-[9px] text-muted-foreground text-center leading-tight">{label}</span>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

// ── Panel 6 — Provider Directory Health ──────────────────────────────────────

function Panel6({ data }) {
  const verified   = data?.verified_count            ?? 0;
  const unverified = data?.unverified_count          ?? 0;
  const reports    = data?.open_wrong_number_reports ?? 0;
  const total      = verified + unverified || 1;
  const verifiedPct = Math.round((verified / total) * 100);
  const reportLevel = reports === 0 ? 'green' : reports < 5 ? 'amber' : 'red';

  return (
    <PanelShell
      title="PROVIDER DIRECTORY HEALTH"
      tooltip="Verification coverage for payment methods and open wrong-number dispute reports."
      data={data}
    >
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Verified</span>
          <span className="font-mono text-green-400 font-semibold tabular-nums">{verified}</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden bg-white/5">
          <div
            className="h-full bg-green-400/60 rounded-full"
            style={{ width: `${verifiedPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-muted-foreground">Unverified</span>
          <span className="font-mono text-muted-foreground tabular-nums">{unverified}</span>
        </div>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-white/5">
        <span className="text-[11px] text-muted-foreground">Open wrong-number reports</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-foreground tabular-nums">{reports}</span>
          <Dot level={reportLevel} />
        </div>
      </div>
    </PanelShell>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminSecurityDashboard() {
  const { user } = useAuth();

  const [snapshot,      setSnapshot]      = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchAdminSocSnapshot([
      'panel_1_system_health',
      'panel_2_webhook_health_24h',
      'panel_3_risk_trend_24h',
      'panel_4_payment_flow',
      'panel_5_scam_signals',
      'panel_6_provider_health',
    ]);
    if (result.error) {
      setError(result.error);
    } else {
      setSnapshot(result);
      setError(null);
      setLastUpdatedAt(Date.now());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  // RBAC guard (after hooks — React rules of hooks require unconditional hook calls above)
  if (user && !canViewFraudDashboard(user)) {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 py-12">
        <div className="w-14 h-14 rounded-2xl bg-red-400/10 border border-red-400/20 flex items-center justify-center mb-4">
          <Lock size={22} className="text-red-400" />
        </div>
        <p className="text-base font-bold text-foreground font-grotesk mb-1">Access Restricted</p>
        <p className="text-xs text-muted-foreground text-center">
          You need fraud_analyst or admin privileges to view this page.
        </p>
      </div>
    );
  }

  const panels = snapshot?.panels ?? {};
  const ageSecs = lastUpdatedAt
    ? Math.floor((Date.now() - lastUpdatedAt) / 1000)
    : null;
  const freshnessColor =
    ageSecs == null  ? 'bg-muted-foreground' :
    ageSecs < 45     ? 'bg-green-400 animate-pulse' :
                       'bg-amber-400';

  return (
    <div className="px-4 py-4 pb-10 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-bold text-foreground font-grotesk uppercase tracking-wider">
          Security Ops — Strategic Overview
        </h1>
        <div className="flex items-center gap-2.5">
          {lastUpdatedAt && (
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${freshnessColor}`} />
              <span className="font-mono text-[10px] text-muted-foreground">
                Last updated: {relativeTime(lastUpdatedAt)}
              </span>
            </div>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="w-7 h-7 rounded-lg bg-white/5 border border-white/8 flex items-center justify-center disabled:opacity-40"
            title="Refresh now"
          >
            <RefreshCw
              size={11}
              className={`text-muted-foreground ${loading ? 'animate-spin' : ''}`}
            />
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-400/8 border border-red-400/20">
          <AlertCircle size={12} className="text-red-400 shrink-0" />
          <span className="text-[11px] text-red-400 flex-1">
            Failed to load: <span className="font-mono">{error}</span>
          </span>
          <button onClick={load} className="text-[10px] text-red-400 underline ml-2">
            Retry
          </button>
        </div>
      )}

      {/* Initial loading state */}
      {loading && !snapshot && !error && (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      )}

      {/* Panels grid — shown once we have snapshot or after an error (empty panels = undefined data) */}
      {(snapshot || error) && (
        <div className="space-y-3">
          {/* Row 1 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Panel1 data={panels.panel_1_system_health} />
            <Panel2 data={panels.panel_2_webhook_health_24h} />
            <Panel3 data={panels.panel_3_risk_trend_24h} />
          </div>
          {/* Row 2 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Panel4 data={panels.panel_4_payment_flow} />
            <Panel5 data={panels.panel_5_scam_signals} />
            <Panel6 data={panels.panel_6_provider_health} />
          </div>
        </div>
      )}
    </div>
  );
}
