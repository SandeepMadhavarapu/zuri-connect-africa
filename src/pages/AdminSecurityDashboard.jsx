/**
 * Zuri Connect Africa — Admin Security Dashboard (Fraud Ops Center)
 * Requires fraud_analyst or admin role. Dark glass-card premium design.
 */

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence }          from 'framer-motion';
import { useNavigate }                      from 'react-router-dom';
import {
  ShieldAlert, ShieldCheck, Activity, AlertTriangle,
  RefreshCw, Clock, Cpu, Layers,
  CheckCircle2, XCircle, RotateCcw, ChevronRight, Lock, Info,
} from 'lucide-react';

import { useAuth }              from '@/lib/AuthContext';
import { canViewFraudDashboard } from '@/lib/rbac';
import { getAuditLog, SEVERITY, AUDIT_ACTIONS } from '@/lib/auditLogger';
import { getAllSettlements, SETTLEMENT_STATUS }  from '@/lib/settlementEngine';
import { getQueueStats, getDeadLetterJobs, QUEUES } from '@/lib/queue';
import { getDeviceInfo }                          from '@/lib/deviceTrust';
import { getMetrics, METRICS }                   from '@/lib/observability';
import { retryFailed as retryFailedSettlements } from '@/api/settlement';

// ── Helpers ───────────────────────────────────────────────────────────────────

function useDashboardData() {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);

    const auditLog    = getAuditLog();
     const settlements = Object.values(getAllSettlements());
     const qStats      = getQueueStats(QUEUES.SETTLEMENT);
     const dlq         = getDeadLetterJobs();
     const metrics     = getMetrics();
     const deviceInfo  = getDeviceInfo();
     const deviceRisk  = { deviceRisk: deviceInfo.isTrusted ? 'low' : 'medium', riskReason: 'Admin device' };

    const fraudAlerts = auditLog.filter(e =>
      e.severity === SEVERITY.HIGH || e.severity === SEVERITY.CRITICAL
    ).slice(-20).reverse();

    const authFailures = auditLog.filter(e => e.action === AUDIT_ACTIONS.AUTH_FAILED).slice(-10).reverse();

    const settledCount = settlements.filter(s => s.settlementStatus === SETTLEMENT_STATUS.SETTLED).length;
    const failedCount  = settlements.filter(s => s.settlementStatus === SETTLEMENT_STATUS.FAILED).length;
    const pendingCount = settlements.filter(s => s.settlementStatus === SETTLEMENT_STATUS.PENDING).length;
    const failureRate  = settlements.length > 0
      ? Math.round((failedCount / settlements.length) * 100)
      : 0;

    const lastRecon = auditLog
      .filter(e => e.action === AUDIT_ACTIONS.RECONCILIATION_EXECUTED)
      .slice(-1)[0] || null;

    setData({
      fraudAlerts,
      authFailures,
      settlements: { settled: settledCount, failed: failedCount, pending: pendingCount, failureRate, total: settlements.length },
      queue:       { ...qStats, dlqCount: dlq.length },
      metrics,
      deviceRisk,
      lastRecon,
      lastUpdated: Date.now(),
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, loading, refresh };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, sub, color = 'text-primary', accent = 'border-primary/15' }) {
  return (
    <div className={`glass-card rounded-2xl p-4 border ${accent}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={13} className={color} />
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <p className={`font-grotesk font-bold text-xl ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}

function SeverityBadge({ severity }) {
  const map = {
    [SEVERITY.CRITICAL]: 'bg-red-400/15 text-red-400 border-red-400/25',
    [SEVERITY.HIGH]:     'bg-amber-400/15 text-amber-400 border-amber-400/25',
    [SEVERITY.MEDIUM]:   'bg-blue-400/15 text-blue-400 border-blue-400/25',
    [SEVERITY.LOW]:      'bg-primary/10 text-primary border-primary/20',
  };
  return (
    <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md border ${map[severity] || map[SEVERITY.LOW]}`}>
      {severity}
    </span>
  );
}

function FraudFeed({ alerts }) {
  if (!alerts?.length) {
    return (
      <div className="flex flex-col items-center py-8 gap-2">
        <ShieldCheck size={24} className="text-primary opacity-50" />
        <p className="text-xs text-muted-foreground">No high-severity events</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {alerts.map((entry, i) => (
        <motion.div key={entry.entryId || i}
          initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
          transition={{ delay: i * 0.03 }}
          className="flex items-start gap-3 px-3 py-2.5 rounded-xl bg-white/3 border border-white/5"
        >
          <AlertTriangle size={12} className={entry.severity === SEVERITY.CRITICAL ? 'text-red-400 mt-0.5' : 'text-amber-400 mt-0.5'} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <p className="text-[11px] font-medium text-foreground capitalize">
                {entry.action?.replace(/_/g, ' ')}
              </p>
              <SeverityBadge severity={entry.severity} />
            </div>
            <p className="text-[10px] text-muted-foreground truncate">
              {entry.userId} · {new Date(entry.epochMs).toLocaleTimeString()}
            </p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function SettlementMonitor({ settlements, onRetry, retrying }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: 'Settled',  value: settlements.settled,  color: 'text-primary' },
          { label: 'Pending',  value: settlements.pending,  color: 'text-amber-400' },
          { label: 'Failed',   value: settlements.failed,   color: 'text-red-400' },
        ].map(s => (
          <div key={s.label} className="glass-card rounded-xl p-3 text-center border border-white/5">
            <p className={`font-grotesk font-bold text-lg ${s.color}`}>{s.value}</p>
            <p className="text-[10px] text-muted-foreground">{s.label}</p>
          </div>
        ))}
      </div>
      {settlements.failed > 0 && (
        <button onClick={onRetry} disabled={retrying}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-amber-400/8 border border-amber-400/20 text-amber-400 text-xs font-semibold disabled:opacity-50">
          {retrying
            ? <><motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}><RefreshCw size={12} /></motion.div> Retrying…</>
            : <><RotateCcw size={12} /> Retry {settlements.failed} failed</>
          }
        </button>
      )}
    </div>
  );
}

function QueueMonitor({ queue }) {
  const items = [
    { label: 'Pending',    value: queue.pending,    color: 'text-amber-400' },
    { label: 'Processing', value: queue.processing, color: 'text-blue-400' },
    { label: 'Completed',  value: queue.completed,  color: 'text-primary' },
    { label: 'Dead Letter',value: queue.dlqCount,   color: 'text-red-400' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {items.map(item => (
        <div key={item.label} className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-white/3 border border-white/5">
          <div className={`w-1.5 h-1.5 rounded-full ${item.value > 0 ? 'bg-current' : 'bg-muted'} ${item.color}`} />
          <div>
            <p className={`font-grotesk font-semibold text-sm ${item.color}`}>{item.value}</p>
            <p className="text-[9px] text-muted-foreground">{item.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminSecurityDashboard() {
  const { user }             = useAuth();
  const navigate             = useNavigate();
  const { data, loading, refresh } = useDashboardData();
  const [retrying, setRetrying]    = useState(false);

  // RBAC guard
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

  const handleRetry = async () => {
    setRetrying(true);
    try { await retryFailedSettlements(user?.email); } catch {}
    refresh();
    setRetrying(false);
  };

  return (
    <div className="px-4 py-4 pb-10 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground font-grotesk">Fraud Ops Center</h1>
          <p className="text-[11px] text-muted-foreground">
            {data?.lastUpdated ? `Updated ${new Date(data.lastUpdated).toLocaleTimeString()}` : 'Loading…'}
          </p>
        </div>
        <button onClick={refresh} disabled={loading}
          className="w-8 h-8 rounded-xl bg-white/5 border border-white/8 flex items-center justify-center">
          <motion.div animate={loading ? { rotate: 360 } : {}} transition={{ repeat: loading ? Infinity : 0, duration: 1, ease: 'linear' }}>
            <RefreshCw size={13} className="text-muted-foreground" />
          </motion.div>
        </button>
      </div>

      {/* Data-scope banner — session telemetry */}
      <div
        className="glass-card rounded-xl px-3 py-2 flex items-start gap-2"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Session telemetry — signals reflect this browser session&apos;s audit log and settlement queue.
          Production deployment streams from Supabase aggregations.
        </p>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-16">
          <div className="w-6 h-6 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
        </div>
      ) : (
        <AnimatePresence>
          <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">

            {/* System Health Row */}
            <div className="grid grid-cols-2 gap-3">
              <MetricCard
                icon={Activity}
                label="Failure Rate"
                value={`${data?.settlements.failureRate ?? 0}%`}
                sub={`${data?.settlements.total || 0} total settlements`}
                color={data?.settlements.failureRate > 10 ? 'text-red-400' : 'text-primary'}
                accent={data?.settlements.failureRate > 10 ? 'border-red-400/15' : 'border-primary/15'}
              />
              <MetricCard
                icon={Layers}
                label="Dead Letter"
                value={data?.queue.dlqCount ?? 0}
                sub="Jobs in DLQ"
                color={data?.queue.dlqCount > 0 ? 'text-red-400' : 'text-primary'}
                accent={data?.queue.dlqCount > 0 ? 'border-red-400/15' : 'border-primary/15'}
              />
              <MetricCard
                icon={ShieldAlert}
                label="Fraud Triggers"
                value={data?.metrics[METRICS.FRAUD_TRIGGER_COUNT]?.count ?? 0}
                sub="This session"
                color="text-amber-400"
                accent="border-amber-400/15"
              />
              <MetricCard
                icon={Lock}
                label="Auth Failures"
                value={data?.metrics[METRICS.AUTH_FAILURE_COUNT]?.count ?? 0}
                sub="This session"
                color={data?.metrics[METRICS.AUTH_FAILURE_COUNT]?.count > 3 ? 'text-red-400' : 'text-blue-400'}
                accent="border-blue-400/15"
              />
            </div>

            {/* Device risk */}
            {data?.deviceRisk && (
              <div className={`glass-card rounded-2xl px-4 py-3 flex items-center gap-3 border ${
                data.deviceRisk.deviceRisk === 'high'   ? 'border-red-400/20' :
                data.deviceRisk.deviceRisk === 'medium' ? 'border-amber-400/20' : 'border-primary/15'
              }`}>
                <Cpu size={14} className={
                  data.deviceRisk.deviceRisk === 'high'   ? 'text-red-400' :
                  data.deviceRisk.deviceRisk === 'medium' ? 'text-amber-400' : 'text-primary'
                } />
                <div className="flex-1">
                  <p className="text-[11px] font-semibold text-foreground">Current Device Risk</p>
                  <p className="text-[10px] text-muted-foreground">
                    {data.deviceRisk.riskReason || 'Trusted device'}
                  </p>
                </div>
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                  data.deviceRisk.deviceRisk === 'high'   ? 'text-red-400 bg-red-400/10 border-red-400/20' :
                  data.deviceRisk.deviceRisk === 'medium' ? 'text-amber-400 bg-amber-400/10 border-amber-400/20' :
                  'text-primary bg-primary/10 border-primary/20'
                }`}>{data.deviceRisk.deviceRisk}</span>
              </div>
            )}

            {/* Fraud Feed — session audit log */}
            <div className="glass-card rounded-2xl p-4 border border-white/6">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Fraud Feed
              </p>
              <FraudFeed alerts={data?.fraudAlerts} />
            </div>

            {/* Settlement Monitor */}
            <div className="glass-card rounded-2xl p-4 border border-white/6">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Settlement Monitor
              </p>
              <SettlementMonitor
                settlements={data?.settlements || { settled: 0, pending: 0, failed: 0, failureRate: 0, total: 0 }}
                onRetry={handleRetry}
                retrying={retrying}
              />
            </div>

            {/* Queue Health */}
            <div className="glass-card rounded-2xl p-4 border border-white/6">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Queue Health
              </p>
              <QueueMonitor queue={data?.queue || { pending: 0, processing: 0, completed: 0, dlqCount: 0 }} />
            </div>

            {/* Auth Failures */}
            <div className="glass-card rounded-2xl p-4 border border-white/6">
              <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-3">
                Recent Auth Failures
              </p>
              {data?.authFailures?.length ? (
                <div className="space-y-2">
                  {data.authFailures.map((e, i) => (
                    <div key={i} className="flex items-center gap-3 px-3 py-2 rounded-xl bg-white/3 border border-white/5">
                      <XCircle size={12} className="text-red-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[11px] text-foreground truncate">{e.userId}</p>
                        <p className="text-[10px] text-muted-foreground">{new Date(e.epochMs).toLocaleTimeString()}</p>
                      </div>
                      <SeverityBadge severity={e.severity} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex items-center gap-2 py-4 justify-center">
                  <CheckCircle2 size={16} className="text-primary opacity-50" />
                  <p className="text-xs text-muted-foreground">No auth failures this session</p>
                </div>
              )}
            </div>

            {/* Reconciliation Status */}
            <div className={`glass-card rounded-2xl px-4 py-3 flex items-center gap-3 border ${
              data?.lastRecon ? 'border-primary/15' : 'border-white/6'
            }`}>
              <Clock size={14} className="text-primary shrink-0" />
              <div className="flex-1">
                <p className="text-[11px] font-semibold text-foreground">Last Reconciliation</p>
                <p className="text-[10px] text-muted-foreground">
                  {data?.lastRecon
                    ? new Date(data.lastRecon.epochMs).toLocaleString()
                    : 'No reconciliation run this session'}
                </p>
              </div>
              <button onClick={() => navigate('/audit')} className="flex items-center gap-1 text-[10px] text-primary">
                View <ChevronRight size={10} />
              </button>
            </div>

          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}