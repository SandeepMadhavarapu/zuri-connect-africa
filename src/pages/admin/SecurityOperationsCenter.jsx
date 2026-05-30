/**
 * Security Operations Center — incident-response drill-down (panels 7–12).
 * Data source: admin-soc-readonly Edge Function (Phase 5.2).
 * Role guard: fraud_analyst, admin, auditor, operator.
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertCircle, Lock, RefreshCw }     from 'lucide-react';
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

function trunc8(str)     { return str ? String(str).slice(0, 8)                                            : '—'; }
function truncAt(str, n) { if (!str) return '—'; const s = String(str); return s.length > n ? s.slice(0, n) + '…' : s; }

// ── Severity tokens ───────────────────────────────────────────────────────────

const SEV_DOT = {
  info:     'bg-zinc-500',
  warn:     'bg-amber-500',
  warning:  'bg-amber-500',
  critical: 'bg-red-500',
  success:  'bg-emerald-500',
};
const SEV_TEXT = {
  info:     'text-zinc-400',
  warn:     'text-amber-400',
  warning:  'text-amber-400',
  critical: 'text-red-400',
  success:  'text-emerald-400',
};

// ── Shared table primitives ───────────────────────────────────────────────────

const TH = ({ children, right }) => (
  <th
    className={`px-3 py-2 text-[9px] font-semibold text-muted-foreground uppercase tracking-wider
                whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}
  >
    {children}
  </th>
);

const TD = ({ children, mono, right, dim, className = '' }) => (
  <td
    className={`px-3 py-2.5 text-[11px] align-middle
                ${mono ? 'font-mono' : ''}
                ${right ? 'text-right' : ''}
                ${dim ? 'text-muted-foreground' : ''}
                ${className}`}
  >
    {children}
  </td>
);

function EmptyRow({ colSpan, message, green }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center">
        <span className={`text-[11px] ${green ? 'text-emerald-400' : 'text-muted-foreground'}`}>
          {message}
        </span>
      </td>
    </tr>
  );
}

function Badge({ label, cls }) {
  return (
    <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${cls}`}>
      {label}
    </span>
  );
}

// ── Panel shell (table-heavy variant) ────────────────────────────────────────
// data === null      → role-restricted: show locked card
// data              → render children (incl. empty-array states within panels)

function PanelShell({ title, badge, data, children }) {
  if (data === null) {
    return (
      <div className="glass-card rounded-xl border border-white/6 px-4 py-4 flex items-center gap-2 min-h-[80px]">
        <Lock size={11} className="text-muted-foreground shrink-0" />
        <span className="text-[11px] text-muted-foreground">
          Restricted — admin or auditor required
        </span>
      </div>
    );
  }
  return (
    <div className="glass-card rounded-xl border border-white/6 flex flex-col">
      {/* Title row — always visible at top, NOT part of scroll */}
      <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-white/5">
        <p className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground flex-1">
          {title}
        </p>
        {badge != null && (
          <span className="font-mono text-[9px] text-muted-foreground/50">{badge}</span>
        )}
      </div>
      {/* Scrollable table body — sticky thead works against this overflow-y ancestor */}
      <div className="overflow-y-auto" style={{ maxHeight: '480px' }}>
        {children}
      </div>
    </div>
  );
}

// ── Panel 7 — Live Audit Stream ───────────────────────────────────────────────

function Panel7({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <PanelShell
      title="LIVE AUDIT STREAM"
      badge={rows.length > 0 ? `showing ${rows.length} of last 50` : undefined}
      data={data}
    >
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <TH>Time</TH>
            <TH>Severity</TH>
            <TH>Category</TH>
            <TH>Event</TH>
            <TH>Actor</TH>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={5} message="No audit events in the last hour" />
          ) : (
            rows.map((row) => {
              const dot  = SEV_DOT[row.severity]  ?? SEV_DOT.info;
              const text = SEV_TEXT[row.severity] ?? SEV_TEXT.info;
              return (
                <tr
                  key={row.id}
                  className="border-b border-white/4 hover:bg-white/[0.025] cursor-pointer transition-colors"
                >
                  <TD mono>
                    <span title={row.created_at ? new Date(row.created_at).toLocaleString() : undefined}>
                      {relativeTime(row.created_at)}
                    </span>
                  </TD>
                  <TD>
                    <div className="flex items-center gap-1.5">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
                      <span className={`text-[10px] font-semibold ${text}`}>
                        {row.severity ?? 'info'}
                      </span>
                    </div>
                  </TD>
                  <TD mono dim>{row.event_category ?? '—'}</TD>
                  <TD mono>{truncAt(row.event_type, 32)}</TD>
                  <TD mono dim>
                    <span title={row.actor_id ?? undefined}>{trunc8(row.actor_id)}</span>
                  </TD>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </PanelShell>
  );
}

// ── Panel 8 — Manual Review Queue ────────────────────────────────────────────

function mismatchBadge(amountMatch, phoneMatch) {
  const badAmount = amountMatch === false;
  const badPhone  = phoneMatch  === false;
  if (badAmount && badPhone) return { label: 'both',             cls: 'text-red-400    border-red-400/25    bg-red-400/8'    };
  if (badAmount)             return { label: 'amount_mismatch',  cls: 'text-amber-400  border-amber-400/25  bg-amber-400/8'  };
  if (badPhone)              return { label: 'phone_mismatch',   cls: 'text-amber-400  border-amber-400/25  bg-amber-400/8'  };
  return                            { label: 'ok',               cls: 'text-emerald-400 border-emerald-400/25 bg-emerald-400/8' };
}

function Panel8({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <PanelShell
      title="MANUAL REVIEW QUEUE"
      badge={rows.length > 0 ? `${rows.length} pending` : undefined}
      data={data}
    >
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <TH>Created</TH>
            <TH>TX Ref</TH>
            <TH right>Amount</TH>
            <TH>Mismatch</TH>
            <TH>Action needed</TH>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={5} message="Review queue empty — well done" green />
          ) : (
            rows.map((row) => {
              const { label, cls } = mismatchBadge(row.amount_match, row.phone_match);
              return (
                <tr key={row.id} className="border-b border-white/4 hover:bg-white/[0.025]">
                  <TD mono dim>{relativeTime(row.created_at)}</TD>
                  <TD mono dim>
                    <span title={row.external_reference ?? undefined}>
                      {truncAt(row.external_reference, 18)}
                    </span>
                  </TD>
                  <TD right mono dim>—</TD>
                  <TD>
                    <Badge label={label} cls={cls} />
                  </TD>
                  <TD>
                    <button className="text-[10px] text-primary/70 underline hover:text-primary">
                      review
                    </button>
                  </TD>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </PanelShell>
  );
}

// ── Panel 9 — Device Trust Registry ──────────────────────────────────────────

function trustBadge(trusted, revokedAt) {
  if (revokedAt) return { label: 'revoked',   cls: 'text-red-400    border-red-400/25    bg-red-400/8'       };
  if (trusted)   return { label: 'trusted',   cls: 'text-emerald-400 border-emerald-400/25 bg-emerald-400/8' };
  return                { label: 'untrusted', cls: 'text-amber-400  border-amber-400/25  bg-amber-400/8'     };
}

function Panel9({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <PanelShell
      title="DEVICE TRUST REGISTRY"
      badge={rows.length > 0 ? `${rows.length} devices` : undefined}
      data={data}
    >
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <TH>Last seen</TH>
            <TH>Device</TH>
            <TH>User</TH>
            <TH>Trust</TH>
            <TH>Status</TH>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={5} message="No recent device events" />
          ) : (
            rows.map((row) => {
              const { label, cls } = trustBadge(row.trusted, row.revoked_at);
              return (
                <tr key={row.id} className="border-b border-white/4 hover:bg-white/[0.025]">
                  <TD mono dim>{relativeTime(row.last_seen_at)}</TD>
                  <TD>
                    <p className="text-[11px] text-foreground">{row.device_label ?? '—'}</p>
                  </TD>
                  <TD mono dim>
                    <span title={row.user_id ?? undefined}>{trunc8(row.user_id)}</span>
                  </TD>
                  <TD>
                    <Badge label={label} cls={cls} />
                  </TD>
                  <TD mono dim>
                    {row.revoked_at ? relativeTime(row.revoked_at) : 'active'}
                  </TD>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </PanelShell>
  );
}

// ── Panel 10 — Webhook Failures & DLQ ────────────────────────────────────────

const SOURCE_CLS = {
  daraja:         'text-emerald-400 border-emerald-400/25 bg-emerald-400/8',
  africastalking: 'text-blue-400    border-blue-400/25    bg-blue-400/8',
};

function sourceBadgeCls(source) {
  return SOURCE_CLS[source] ?? 'text-zinc-400 border-zinc-400/25 bg-zinc-400/8';
}

function Panel10({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <PanelShell
      title="WEBHOOK FAILURES"
      badge={rows.length > 0 ? `${rows.length} failures` : undefined}
      data={data}
    >
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <TH>Failed at</TH>
            <TH>Source</TH>
            <TH>Idempotency key</TH>
            <TH>Action</TH>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={4} message="No webhook failures in the last 24h" green />
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="border-b border-white/4 hover:bg-white/[0.025]">
                <TD mono dim>{relativeTime(row.created_at)}</TD>
                <TD>
                  <Badge label={row.source ?? 'unknown'} cls={sourceBadgeCls(row.source)} />
                </TD>
                <TD mono dim>
                  <span title={row.idempotency_key ?? undefined}>
                    {truncAt(row.idempotency_key, 28)}
                  </span>
                </TD>
                <TD>
                  <button className="text-[10px] text-primary/70 underline hover:text-primary">
                    Investigate
                  </button>
                </TD>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </PanelShell>
  );
}

// ── Panel 11 — Reconciliation Runs ───────────────────────────────────────────

function runDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 0) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

const RUN_STATUS_CLS = {
  completed: 'text-emerald-400 border-emerald-400/25 bg-emerald-400/8',
  running:   'text-amber-400   border-amber-400/25   bg-amber-400/8',
};
function runStatusCls(s) { return RUN_STATUS_CLS[s] ?? 'text-red-400 border-red-400/25 bg-red-400/8'; }

const RUN_TYPE_CLS = {
  full:   'text-blue-400   border-blue-400/25   bg-blue-400/8',
  spot:   'text-zinc-400   border-zinc-400/25   bg-zinc-400/8',
  replay: 'text-amber-400  border-amber-400/25  bg-amber-400/8',
};
function runTypeCls(t) { return RUN_TYPE_CLS[t] ?? 'text-zinc-400 border-zinc-400/25 bg-zinc-400/8'; }

function Panel11({ data }) {
  const runs  = data?.last_10_runs           ?? [];
  const trend = data?.daily_difference_trend ?? [];
  const maxDiff = Math.max(1, ...trend.map((d) => Math.abs(d.difference ?? 0)));

  return (
    <PanelShell title="RECONCILIATION RUNS" data={data}>
      {/* Top: last 10 runs table */}
      <div className="border-b border-white/5">
        <p className="px-4 pt-2.5 pb-1 text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
          Last 10 runs
        </p>
        <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <TH>Started</TH>
              <TH>Type</TH>
              <TH>Status</TH>
              <TH>Orphans (D/C)</TH>
              <TH>Duration</TH>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <EmptyRow colSpan={5} message="No reconciliation runs recorded" />
            ) : (
              runs.map((run) => {
                const orphanRed = (run.orphan_debits ?? 0) > 0 || (run.orphan_credits ?? 0) > 0;
                return (
                  <tr key={run.run_id} className="border-b border-white/4 hover:bg-white/[0.025]">
                    <TD mono dim>{relativeTime(run.started_at)}</TD>
                    <TD>
                      <Badge label={run.run_type ?? '—'} cls={runTypeCls(run.run_type)} />
                    </TD>
                    <TD>
                      <Badge label={run.status ?? '—'} cls={runStatusCls(run.status)} />
                    </TD>
                    <TD mono className={orphanRed ? 'text-red-400 font-semibold' : 'text-muted-foreground'}>
                      {`${run.orphan_debits ?? 0} / ${run.orphan_credits ?? 0}`}
                    </TD>
                    <TD mono dim>{runDuration(run.started_at, run.completed_at)}</TD>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Bottom: 7-day daily difference trend bar chart */}
      <div className="px-4 py-3">
        <p className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wider mb-2">
          Daily difference trend (7d)
        </p>
        {trend.length < 2 ? (
          <p className="text-[11px] text-muted-foreground">
            Insufficient data — needs 7 days of logs
          </p>
        ) : (
          <div className="flex items-end gap-1 h-12">
            {trend.map((d, i) => {
              const diff       = Math.abs(d.difference ?? 0);
              const heightPct  = Math.max(4, Math.round((diff / maxDiff) * 100));
              const barColor   =
                diff === 0 ? 'bg-emerald-400/60' :
                diff < 100 ? 'bg-amber-400/60'   :
                             'bg-red-400/60';
              const label = d.run_date ? String(d.run_date).slice(0, 10) : `day ${i + 1}`;
              return (
                <div
                  key={i}
                  className={`flex-1 rounded-sm ${barColor}`}
                  style={{ height: `${heightPct}%` }}
                  title={`${label} — diff: ${d.difference ?? 0}`}
                />
              );
            })}
          </div>
        )}
      </div>
    </PanelShell>
  );
}

// ── Panel 12 — Provider Wrong Number Queue ────────────────────────────────────

const REPORT_STATUS_CLS = {
  investigating: 'text-blue-400  border-blue-400/25  bg-blue-400/8',
  open:          'text-amber-400 border-amber-400/25 bg-amber-400/8',
};
function reportStatusCls(s) { return REPORT_STATUS_CLS[s] ?? REPORT_STATUS_CLS.open; }

function Panel12({ data }) {
  const rows = Array.isArray(data) ? data : [];
  return (
    <PanelShell
      title="WRONG NUMBER QUEUE"
      badge={rows.length > 0 ? `${rows.length} open` : undefined}
      data={data}
    >
      <table className="w-full border-separate" style={{ borderSpacing: 0 }}>
        <thead className="sticky top-0 z-10 bg-card">
          <tr>
            <TH>Reported</TH>
            <TH>Shortcode</TH>
            <TH>Reporter</TH>
            <TH>Status</TH>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={4} message="No open wrong-number reports" green />
          ) : (
            rows.map((row) => (
              <tr key={row.id} className="border-b border-white/4 hover:bg-white/[0.025]">
                <TD mono dim>{relativeTime(row.created_at)}</TD>
                <TD mono dim>
                  <span title={row.payment_method_id ?? undefined}>
                    {truncAt(row.payment_method_id, 12)}
                  </span>
                </TD>
                <TD mono dim>
                  <span title={row.reporter_user_id ?? undefined}>
                    {trunc8(row.reporter_user_id)}
                  </span>
                </TD>
                <TD>
                  <Badge
                    label={row.status ?? 'open'}
                    cls={reportStatusCls(row.status)}
                  />
                </TD>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </PanelShell>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function SecurityOperationsCenter() {
  const { user } = useAuth();

  const [snapshot,      setSnapshot]      = useState(null);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchAdminSocSnapshot([
      'panel_7_live_audit',
      'panel_8_manual_review_queue',
      'panel_9_device_trust',
      'panel_10_webhook_failures',
      'panel_11_reconciliation_runs',
      'panel_12_wrong_number_queue',
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

  // RBAC guard — hooks must be unconditional, so guard comes after
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

  const ageSecs = lastUpdatedAt ? Math.floor((Date.now() - lastUpdatedAt) / 1000) : null;
  const freshnessColor =
    ageSecs == null ? 'bg-muted-foreground' :
    ageSecs < 45    ? 'bg-green-400 animate-pulse' :
                      'bg-amber-400';

  return (
    <div className="px-4 py-4 pb-10 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-bold text-foreground font-grotesk uppercase tracking-wider">
          Security Operations Center
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

      {/* Initial loading spinner */}
      {loading && !snapshot && !error && (
        <div className="flex items-center justify-center py-16">
          <div className="w-5 h-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      )}

      {/* Panels — stacked vertically for top-to-bottom incident triage */}
      {(snapshot || error) && (
        <div className="space-y-4">
          <Panel7  data={panels.panel_7_live_audit} />
          <Panel8  data={panels.panel_8_manual_review_queue} />
          <Panel9  data={panels.panel_9_device_trust} />
          <Panel10 data={panels.panel_10_webhook_failures} />
          <Panel11 data={panels.panel_11_reconciliation_runs} />
          <Panel12 data={panels.panel_12_wrong_number_queue} />
        </div>
      )}
    </div>
  );
}
