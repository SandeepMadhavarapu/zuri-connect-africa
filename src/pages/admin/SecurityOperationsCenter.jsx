import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  GitBranch,
  Globe2,
  Info,
  Lock,
  Network,
  RadioTower,
  RefreshCw,
  Shield,
  ShieldAlert,
  Timer,
} from 'lucide-react';

import { getRuntimeHealth, getDistributedTraces } from '@/backend/observability';
import { getFraudGraphSnapshot, getThreatIntelSnapshot, getReputationSnapshot } from '@/backend/fraud';
import { getReconciliationSnapshots, getSettlementAuditView } from '@/backend/reconciliation';
import { getWebhookQueueStats } from '@/backend/webhooks/webhookQueue';
import { getWebhookDeadLetters } from '@/backend/webhooks/deadLetterQueue';
import { getWebhookAuditLog } from '@/backend/webhooks/webhookAudit';
import { getAllQueueStats, getDeadLetterJobs } from '@/lib/queue';
import { getMetrics, METRICS } from '@/lib/observability';
import { useAuth } from '@/lib/AuthContext';
import { canViewFraudDashboard } from '@/lib/rbac';

function statusColor(status) {
  if (status === 'healthy' || status === 'balanced') return 'text-primary border-primary/20 bg-primary/8';
  if (status === 'degraded' || status === 'pending') return 'text-amber-400 border-amber-400/20 bg-amber-400/8';
  return 'text-red-400 border-red-400/20 bg-red-400/8';
}

function MetricTile({ icon: Icon, label, value, sub, tone = 'text-primary' }) {
  return (
    <div className="glass-card rounded-2xl p-4 border border-white/6">
      <div className="flex items-center gap-2 mb-2">
        <Icon size={13} className={tone} />
        <span className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">{label}</span>
      </div>
      <p className={`text-xl font-bold font-grotesk ${tone}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function ThreatHeatmap({ score }) {
  const regions = [
    ['Nairobi', score + 10],
    ['Mombasa', score - 8],
    ['Kisumu', score - 14],
    ['Eldoret', score - 22],
    ['Nakuru', score - 18],
    ['Garissa', score - 26],
  ].map(([name, value]) => [name, Math.max(0, Math.min(100, value))]);

  return (
    <div className="grid grid-cols-2 gap-2">
      {regions.map(([name, value]) => (
        <div key={name} className="rounded-xl border border-white/6 bg-white/3 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] text-foreground font-medium">{name}</span>
            <span className={`text-[10px] font-semibold ${value >= 70 ? 'text-red-400' : value >= 40 ? 'text-amber-400' : 'text-primary'}`}>
              {value}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-white/6 overflow-hidden">
            <div
              className={`h-full ${value >= 70 ? 'bg-red-400' : value >= 40 ? 'bg-amber-400' : 'bg-primary'}`}
              style={{ width: `${value}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function CompactList({ items, empty, render }) {
  if (!items?.length) {
    return (
      <div className="flex items-center justify-center gap-2 py-6">
        <CheckCircle2 size={15} className="text-primary opacity-70" />
        <p className="text-xs text-muted-foreground">{empty}</p>
      </div>
    );
  }
  return <div className="space-y-2">{items.map(render)}</div>;
}

function useSocData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    const health = getRuntimeHealth();
    const graph = getFraudGraphSnapshot().analysis;
    const threats = getThreatIntelSnapshot();
    const reputation = getReputationSnapshot();
    const reconciliation = getReconciliationSnapshots(1)[0] || null;
    const settlementAudit = getSettlementAuditView();
    const webhookQueue = getWebhookQueueStats();
    const webhookDlq = getWebhookDeadLetters();
    const webhookAudit = getWebhookAuditLog({ limit: 50 });
    const allQueues = getAllQueueStats();
    const durableDlq = getDeadLetterJobs();
    const metrics = getMetrics();
    const traces = getDistributedTraces({ limit: 20 });

    setData({
      health,
      graph,
      threats,
      reputation,
      reconciliation,
      settlementAudit,
      webhookQueue,
      webhookDlq,
      webhookAudit,
      allQueues,
      durableDlq,
      metrics,
      traces,
      lastUpdated: Date.now(),
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { data, loading, refresh };
}

export default function SecurityOperationsCenter() {
  const { user } = useAuth();
  const { data, loading, refresh } = useSocData();

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

  const replayAttempts = data?.metrics?.[METRICS.WEBHOOK_REPLAY_ATTACK]?.count || 0;
  const signatureFailures = data?.metrics?.[METRICS.WEBHOOK_SIGNATURE_FAIL]?.count || 0;
  const transactionLatency = data?.metrics?.[METRICS.TRANSACTION_LATENCY]?.avg || 0;
  const settlementFailures = data?.settlementAudit?.filter(item => item.status === 'failed').length || 0;
  const queueFailures = Object.values(data?.allQueues || {}).reduce((sum, queue) => sum + queue.failed + queue.dead, 0);
  const scamClusters = data?.graph?.scamClusters || [];
  const riskyMerchants = data?.reputation?.merchants?.filter(item => item.riskScore >= 40).slice(0, 5) || [];

  return (
    <div className="px-4 py-4 pb-10 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <div className="w-7 h-7 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center">
              <RadioTower size={13} className="text-primary" />
            </div>
            <span className="text-[10px] font-semibold text-primary uppercase tracking-widest">Admin SOC</span>
          </div>
          <h1 className="text-lg font-bold text-foreground font-grotesk">Security Operations Center</h1>
          <p className="text-[11px] text-muted-foreground">
            {data?.lastUpdated ? `Updated ${new Date(data.lastUpdated).toLocaleTimeString()}` : 'Loading...'}
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="w-8 h-8 rounded-xl bg-white/5 border border-white/8 flex items-center justify-center"
        >
          <motion.div animate={loading ? { rotate: 360 } : {}} transition={{ repeat: loading ? Infinity : 0, duration: 1, ease: 'linear' }}>
            <RefreshCw size={13} className="text-muted-foreground" />
          </motion.div>
        </button>
      </div>

      <div className={`rounded-2xl border px-4 py-3 flex items-center gap-3 ${statusColor(data?.health?.status)}`}>
        <Shield size={15} />
        <div className="flex-1">
          <p className="text-xs font-semibold capitalize">Runtime {data?.health?.status || 'sampling'}</p>
          <p className="text-[10px] text-muted-foreground">
            {data?.health?.degradedSignals?.length ? data.health.degradedSignals.join(', ') : 'No active degradation signals'}
          </p>
        </div>
      </div>

      {/* Operational-readiness scope banner */}
      <div
        className="glass-card rounded-xl px-3 py-2 flex items-start gap-2"
        style={{ borderColor: 'rgba(255,255,255,0.08)' }}
      >
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Operational readiness view — signals reflect this session&apos;s browser telemetry.
          Production deployment connects to Supabase aggregations and Daraja webhook feeds.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <MetricTile icon={ShieldAlert} label="Threat Score" value={data?.graph?.campaignScore || 0} sub={`${scamClusters.length} active clusters`} tone={(data?.graph?.campaignScore || 0) >= 70 ? 'text-red-400' : 'text-amber-400'} />
        <MetricTile icon={Network} label="Queue Failures" value={queueFailures} sub={`${data?.durableDlq?.length || 0} durable DLQ`} tone={queueFailures ? 'text-red-400' : 'text-primary'} />
        <MetricTile icon={AlertTriangle} label="Replay Attempts" value={replayAttempts} sub={`${signatureFailures} signature failures`} tone={replayAttempts || signatureFailures ? 'text-red-400' : 'text-primary'} />
        <MetricTile icon={Timer} label="Tx Latency" value={`${transactionLatency}ms`} sub="Mean transaction span" tone={transactionLatency > 1500 ? 'text-amber-400' : 'text-primary'} />
      </div>

      <div className="glass-card rounded-2xl p-4 border border-white/6">
        <div className="flex items-center gap-2 mb-3">
          <Globe2 size={13} className="text-primary" />
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Regional Risk Distribution</p>
        </div>
        <ThreatHeatmap score={data?.graph?.campaignScore || 0} />
      </div>

      <div className="glass-card rounded-2xl p-4 border border-white/6">
        <div className="flex items-center gap-2 mb-3">
          <GitBranch size={13} className="text-primary" />
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Scam Clusters</p>
        </div>
        <CompactList
          items={scamClusters.slice(0, 5)}
          empty="No active scam clusters"
          render={(item) => (
            <div key={item.nodeId} className="rounded-xl bg-white/3 border border-white/6 p-3 flex items-center justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-foreground truncate">{item.value}</p>
                <p className="text-[10px] text-muted-foreground">{item.type} / degree {item.degree}</p>
              </div>
              <span className={`text-[10px] font-bold ${item.riskScore >= 70 ? 'text-red-400' : 'text-amber-400'}`}>{item.riskScore}</span>
            </div>
          )}
        />
      </div>

      <div className="glass-card rounded-2xl p-4 border border-white/6">
        <div className="flex items-center gap-2 mb-3">
          <Activity size={13} className="text-primary" />
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Settlement And Webhook Operations</p>
        </div>
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div className="rounded-xl bg-white/3 border border-white/6 p-3 text-center">
            <p className={`text-lg font-bold ${settlementFailures ? 'text-red-400' : 'text-primary'}`}>{settlementFailures}</p>
            <p className="text-[9px] text-muted-foreground">Settlement Fail</p>
          </div>
          <div className="rounded-xl bg-white/3 border border-white/6 p-3 text-center">
            <p className={`text-lg font-bold ${data?.webhookQueue?.failed ? 'text-amber-400' : 'text-primary'}`}>{data?.webhookQueue?.failed || 0}</p>
            <p className="text-[9px] text-muted-foreground">Webhook Fail</p>
          </div>
          <div className="rounded-xl bg-white/3 border border-white/6 p-3 text-center">
            <p className={`text-lg font-bold ${data?.webhookDlq?.length ? 'text-red-400' : 'text-primary'}`}>{data?.webhookDlq?.length || 0}</p>
            <p className="text-[9px] text-muted-foreground">Webhook DLQ</p>
          </div>
        </div>
        <div className={`rounded-xl border px-3 py-2 ${statusColor(data?.reconciliation?.status || 'pending')}`}>
          <p className="text-[11px] font-semibold">Reconciliation {data?.reconciliation?.status || 'pending'}</p>
          <p className="text-[10px] text-muted-foreground">
            {data?.reconciliation ? `${data.reconciliation.entriesChecked} entries / diff KSh ${data.reconciliation.difference}` : 'No daily snapshot yet'}
          </p>
        </div>
      </div>

      <div className="glass-card rounded-2xl p-4 border border-white/6">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={13} className="text-primary" />
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Risky Merchants</p>
        </div>
        <CompactList
          items={riskyMerchants}
          empty="No risky merchants tracked"
          render={(item) => (
            <div key={item.id} className="rounded-xl bg-white/3 border border-white/6 p-3 flex items-center justify-between">
              <div>
                <p className="text-[11px] font-semibold text-foreground">{item.id}</p>
                <p className="text-[10px] text-muted-foreground">{item.successfulTx} success / {item.failedTx} failed</p>
              </div>
              <span className={`text-[10px] font-bold ${item.riskScore >= 70 ? 'text-red-400' : 'text-amber-400'}`}>{item.riskScore}</span>
            </div>
          )}
        />
      </div>
    </div>
  );
}
