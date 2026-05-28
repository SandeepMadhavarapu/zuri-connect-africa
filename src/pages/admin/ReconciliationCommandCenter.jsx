/**
 * Zuri Connect Africa — Reconciliation Command Center.
 *
 * Hard rules enforced here:
 *   * The page NEVER queries Supabase tables directly. Every read and every
 *     action goes through the `admin-reconciliation` Edge Function via
 *     `src/lib/admin/reconciliationApi.js`.
 *   * Role gating is server-controlled — `viewer_role` returned by the Edge
 *     Function decides which buttons render.
 *   * No raw webhook payloads, callback bodies, or secrets are rendered;
 *     fields are limited to the safe `payment_reconciliation_review` view.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, CheckCircle2, Clock, Lock, RefreshCw, ShieldCheck,
  Activity, GitBranch, ChevronRight,
} from 'lucide-react';

import { useAuth } from '@/lib/AuthContext';
import {
  fetchReconciliationCounts,
  fetchReconciliationQueue,
  markReviewResolved,
  escalateToSupport,
  markTimeoutAcknowledged,
  rejectOrphanCallback,
  retryProviderQuery,
} from '@/lib/admin/reconciliationApi.js';

const FILTERS = [
  { id: 'all',                   label: 'All' },
  { id: 'review',                label: 'Manual review' },
  { id: 'orphan',                label: 'Orphan callback' },
  { id: 'mismatch',              label: 'Amount/Phone mismatch' },
  { id: 'duplicate',             label: 'Duplicate' },
  { id: 'timeout',               label: 'Stuck timeout' },
  { id: 'provider_query_failed', label: 'Provider failure' },
];

function StatTile({ icon: Icon, label, value, tone = 'text-primary' }) {
  return (
    <div className="glass-card rounded-2xl p-4 border border-white/8">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={13} className={tone} />
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">{label}</span>
      </div>
      <p className={`text-xl font-bold font-grotesk ${tone}`}>{value}</p>
    </div>
  );
}

function MatchBadge({ match }) {
  if (match === true)  return <span className="text-[10px] text-primary">match</span>;
  if (match === false) return <span className="text-[10px] text-red-400">mismatch</span>;
  return <span className="text-[10px] text-muted-foreground/60">n/a</span>;
}

function ActionButton({ label, onClick, disabled, tone = 'primary' }) {
  const toneClasses = {
    primary: 'bg-primary/10 border-primary/30 text-primary',
    warn:    'bg-amber-400/10 border-amber-400/30 text-amber-400',
    danger:  'bg-red-400/10 border-red-400/30 text-red-400',
  }[tone];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`text-[10px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-lg border ${toneClasses} disabled:opacity-40`}
    >
      {label}
    </button>
  );
}

function QueueRow({ row, canMutate, canRunAdminOnly, onAction }) {
  const [busy, setBusy] = useState(false);

  const run = async (fn) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  return (
    <div className="glass-card rounded-2xl border border-white/8 p-4 space-y-2.5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[11px] font-bold text-foreground font-grotesk">
            {row.tx_ref || row.external_reference || '—'}
          </p>
          <p className="text-[10px] text-muted-foreground">
            {row.event_type?.replace(/_/g, ' ')} · {new Date(row.created_at).toLocaleString('en-KE')}
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-muted-foreground">
          {row.pending_status || row.internal_status || 'unknown'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
        <div>Provider: <span className="text-foreground">{row.provider_status}</span></div>
        <div>Internal: <span className="text-foreground">{row.internal_status}</span></div>
        <div>Amount: <MatchBadge match={row.amount_match} /></div>
        <div>Phone: <MatchBadge match={row.phone_match} /></div>
        <div>From: <span className="text-foreground">{row.from_phone || '—'}</span></div>
        <div>To: <span className="text-foreground">{row.to_phone || '—'}</span></div>
      </div>

      {row.reason && (
        <p className="text-[11px] text-foreground/80 italic">{row.reason}</p>
      )}

      {canMutate && row.pending_payment_id && (
        <div className="flex flex-wrap gap-2 pt-1">
          <ActionButton
            label="Mark resolved"
            onClick={() => run(() => onAction('mark_review_resolved', { pendingPaymentId: row.pending_payment_id }))}
            disabled={busy}
          />
          <ActionButton
            label="Escalate"
            tone="warn"
            onClick={() => run(() => onAction('escalate_to_support', { pendingPaymentId: row.pending_payment_id }))}
            disabled={busy}
          />
          <ActionButton
            label="Acknowledge timeout"
            onClick={() => run(() => onAction('mark_timeout_acknowledged', { pendingPaymentId: row.pending_payment_id }))}
            disabled={busy}
          />
          {canRunAdminOnly && (
            <ActionButton
              label="Retry provider"
              tone="warn"
              onClick={() => run(() => onAction('retry_provider_query', { pendingPaymentId: row.pending_payment_id }))}
              disabled={busy}
            />
          )}
        </div>
      )}

      {canRunAdminOnly && !row.pending_payment_id && row.event_id && (
        <div className="pt-1">
          <ActionButton
            label="Reject orphan"
            tone="danger"
            onClick={() => run(() => onAction('reject_orphan_callback', { reconciliationEventId: row.event_id }))}
            disabled={busy}
          />
        </div>
      )}
    </div>
  );
}

export default function ReconciliationCommandCenter() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [counts, setCounts]     = useState(null);
  const [queue, setQueue]       = useState({ rows: [], can_mutate: false, can_run_admin_only: false, viewer_role: null });
  const [filter, setFilter]     = useState('all');
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [statusMsg, setStatusMsg] = useState(null);

  const refresh = useCallback(async (nextFilter = filter) => {
    setLoading(true);
    setError(null);
    const [countsResp, queueResp] = await Promise.all([
      fetchReconciliationCounts(),
      fetchReconciliationQueue({ filter: nextFilter, limit: 50 }),
    ]);
    if (countsResp?.ok) setCounts(countsResp.counts);
    if (queueResp?.ok) {
      setQueue({
        rows:              queueResp.rows || [],
        can_mutate:        queueResp.can_mutate,
        can_run_admin_only: queueResp.can_run_admin_only,
        viewer_role:       queueResp.viewer_role,
      });
    } else {
      setError(queueResp?.error || 'queue_unavailable');
    }
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    refresh(filter);
  }, [filter, refresh]);

  const runAction = useCallback(async (action, args) => {
    setStatusMsg(null);
    let response;
    if (action === 'mark_review_resolved')      response = await markReviewResolved(args);
    else if (action === 'escalate_to_support')  response = await escalateToSupport(args);
    else if (action === 'mark_timeout_acknowledged') response = await markTimeoutAcknowledged(args);
    else if (action === 'reject_orphan_callback') response = await rejectOrphanCallback(args);
    else if (action === 'retry_provider_query') response = await retryProviderQuery(args);
    else return;

    if (response?.ok) {
      setStatusMsg({ tone: 'ok', text: `${action.replace(/_/g, ' ')} succeeded` });
      refresh(filter);
    } else {
      setStatusMsg({ tone: 'err', text: response?.error || 'action_failed' });
    }
  }, [filter, refresh]);

  if (user && error === 'forbidden') {
    return (
      <div className="flex flex-col items-center justify-center h-full px-6 py-12">
        <Lock size={22} className="text-red-400 mb-3" />
        <p className="text-base font-bold text-foreground font-grotesk mb-1">Access Restricted</p>
        <p className="text-xs text-muted-foreground text-center">
          You need admin, fraud_analyst, or auditor role on this account to view the reconciliation queue.
        </p>
      </div>
    );
  }

  const pending = counts?.pending || {};
  const recon   = counts?.reconciliation || {};

  return (
    <div className="px-4 py-4 pb-10 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground font-grotesk">Reconciliation Command Center</h1>
          <p className="text-[11px] text-muted-foreground">
            {queue.viewer_role ? `Signed in as ${queue.viewer_role}` : 'Loading role…'}
          </p>
        </div>
        <button
          onClick={() => refresh(filter)}
          disabled={loading}
          className="w-8 h-8 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin text-muted-foreground' : 'text-muted-foreground'} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <StatTile icon={Clock}          label="Waiting for M-PESA" value={pending.waiting_for_mpesa ?? 0} tone="text-amber-400" />
        <StatTile icon={AlertTriangle}  label="Review required"    value={pending.review_required ?? 0} tone="text-red-400" />
        <StatTile icon={Activity}       label="Stuck timeout"      value={recon.stuck_timeout ?? 0} tone="text-amber-400" />
        <StatTile icon={GitBranch}      label="Orphan callbacks"   value={counts?.orphan_callbacks ?? 0} tone="text-red-400" />
        <StatTile icon={AlertTriangle}  label="Amount mismatch"    value={recon.amount_mismatch ?? 0} tone="text-red-400" />
        <StatTile icon={AlertTriangle}  label="Phone mismatch"     value={recon.phone_mismatch ?? 0} tone="text-red-400" />
        <StatTile icon={CheckCircle2}   label="Duplicate callbacks" value={recon.duplicate_callback ?? 0} tone="text-blue-400" />
        <StatTile icon={ShieldCheck}    label="Provider failures"   value={recon.provider_query_failed ?? 0} tone="text-amber-400" />
      </div>

      {!counts?.provider_query_configured && (
        <div className="text-[11px] text-amber-400 bg-amber-400/8 border border-amber-400/20 rounded-xl px-3 py-2">
          Provider query API not configured — `Retry provider` is disabled. Set DARAJA_* secrets to enable.
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`text-[11px] font-semibold uppercase tracking-wider px-2.5 py-1 rounded-lg border ${
              filter === f.id
                ? 'bg-primary/12 border-primary/30 text-primary'
                : 'bg-white/3 border-white/10 text-muted-foreground'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {statusMsg && (
        <div className={`text-[11px] rounded-xl px-3 py-2 border ${
          statusMsg.tone === 'ok'
            ? 'bg-primary/8 border-primary/20 text-primary'
            : 'bg-red-400/8 border-red-400/20 text-red-400'
        }`}>
          {statusMsg.text}
        </div>
      )}

      {loading && !queue.rows.length ? (
        <div className="text-center py-12 text-xs text-muted-foreground">Loading queue…</div>
      ) : queue.rows.length === 0 ? (
        <div className="text-center py-12 text-xs text-muted-foreground">No reconciliation events match the filter.</div>
      ) : (
        <div className="space-y-3">
          {queue.rows.map((row) => (
            <QueueRow
              key={row.event_id}
              row={row}
              canMutate={queue.can_mutate}
              canRunAdminOnly={queue.can_run_admin_only}
              onAction={runAction}
            />
          ))}
        </div>
      )}

      <div className="pt-2 flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>Audit trail: every action writes audit_events server-side.</span>
        <button onClick={() => navigate('/audit')} className="flex items-center gap-1 text-primary">
          Audit log <ChevronRight size={10} />
        </button>
      </div>
    </div>
  );
}
