import { useState } from 'react';
import { Signal, RefreshCw, MapPin, Info } from 'lucide-react';
import RenderGuard from '@/components/system/RenderGuard';

const REGIONS = [
  { name: 'Nairobi CBD',          signal: 98, type: '5G',   latency: 18,  status: 'ok' },
  { name: 'Westlands',            signal: 96, type: '5G',   latency: 21,  status: 'ok' },
  { name: 'Mombasa',              signal: 91, type: '4G+',  latency: 34,  status: 'ok' },
  { name: 'Kisumu',               signal: 87, type: '4G',   latency: 48,  status: 'ok' },
  { name: 'Nakuru',               signal: 82, type: '4G',   latency: 55,  status: 'ok' },
  { name: 'Eldoret',              signal: 78, type: '4G',   latency: 61,  status: 'ok' },
  { name: 'Thika',                signal: 88, type: '4G+',  latency: 42,  status: 'ok' },
  { name: 'Garissa',              signal: 65, type: '3G',   latency: 110, status: 'degraded' },
  { name: 'Mandera',              signal: 44, type: '2G',   latency: 280, status: 'limited' },
  { name: 'Lamu',                 signal: 71, type: '3G',   latency: 130, status: 'degraded' },
];

const SERVICES = [
  { name: 'M-PESA Processing',     status: 'ok',      latency: '42ms',   uptime: '99.97%' },
  { name: 'Voice Calls',           status: 'ok',      latency: '—',      uptime: '99.94%' },
  { name: 'Data Services',         status: 'ok',      latency: '—',      uptime: '99.89%' },
  { name: 'SMS Gateway',           status: 'ok',      latency: '1.2s',   uptime: '99.99%' },
  { name: 'USSD Services',         status: 'ok',      latency: '0.8s',   uptime: '99.96%' },
  { name: 'Bonga Points Platform', status: 'ok',      latency: '88ms',   uptime: '99.81%' },
  { name: 'Fuliza Credit Engine',  status: 'reviewing', latency: '145ms', uptime: '99.72%' },
  { name: 'Push Notifications',    status: 'ok',      latency: '220ms',  uptime: '99.88%' },
];

const statusColor = { ok: 'text-primary', degraded: 'text-amber-400', limited: 'text-red-400', reviewing: 'text-amber-400' };
const statusLabel = { ok: 'Operational', degraded: 'Degraded', limited: 'Limited', reviewing: 'Reviewing' };
const statusBg    = { ok: 'bg-primary/10', degraded: 'bg-amber-400/10', limited: 'bg-red-400/10', reviewing: 'bg-amber-400/10' };

const signalBar = (pct) => {
  if (pct >= 90) return 'text-primary';
  if (pct >= 70) return 'text-amber-400';
  return 'text-red-400';
};

export default function NetworkStatus() {
  const [refreshing, setRefreshing] = useState(false);
  // No real health-probe endpoint is wired yet — REGIONS/SERVICES are a static
  // operator-published snapshot. Real refresh would call a status-API. We keep
  // the spin animation but never claim a live fetch happened.
  const handleRefresh = () => { setRefreshing(true); setTimeout(() => setRefreshing(false), 600); };

  const degraded = REGIONS.filter(r => r.status !== 'ok').length;

  return (
    <RenderGuard name="Network Status">
      <div className="px-4 py-4 pb-8">
        {/* Overall status */}
        <div className="glass-card rounded-2xl p-4 mb-4 flex items-center gap-3"
        style={{ border: degraded > 0 ? '1px solid rgba(240,165,0,0.18)' : '1px solid rgba(46,204,113,0.15)' }}>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${degraded > 0 ? 'bg-amber-400/10' : 'bg-primary/10'}`}>
          <Signal size={17} className={degraded > 0 ? 'text-amber-400' : 'text-primary'} />
        </div>
        <div className="flex-1">
          <p className="text-[13px] font-semibold text-foreground">
            {degraded > 0 ? `Network: ${degraded} region${degraded > 1 ? 's' : ''} with reduced coverage` : 'All networks operational'}
          </p>
          <p className="text-[11px] text-muted-foreground">Operator-published snapshot · Kenya National Network</p>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          aria-label="Refresh status display"
          title="UI refresh only — status is a snapshot, not a live probe"
          className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center"
        >
          <RefreshCw size={13} className={`text-muted-foreground ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="glass-card rounded-xl px-3 py-2 mb-3 flex items-start gap-2" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
        <Info size={11} className="text-muted-foreground shrink-0 mt-0.5" />
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          Network snapshot — operator-published, not a live device probe.
        </p>
      </div>

      {/* Service health */}
      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">Platform Services</p>
      <div className="glass-card rounded-2xl overflow-hidden mb-4" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        {SERVICES.map((s, i) => (
          <div key={s.name} className={`flex items-center gap-3 px-4 py-3 ${i < SERVICES.length - 1 ? 'border-b border-white/5' : ''}`}>
            <div className="flex-1">
              <p className="text-[12px] font-medium text-foreground">{s.name}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-muted-foreground">Uptime {s.uptime}</span>
                {s.latency !== '—' && <span className="text-[10px] text-muted-foreground">· {s.latency}</span>}
              </div>
            </div>
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${statusBg[s.status]} ${statusColor[s.status]}`}>
              {statusLabel[s.status]}
            </span>
          </div>
        ))}
      </div>

      {/* Regional coverage */}
      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-widest mb-2">Regional Coverage</p>
      <div className="glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        {REGIONS.map((r, i) => (
          <div key={r.name} className={`flex items-center gap-3 px-4 py-3 ${i < REGIONS.length - 1 ? 'border-b border-white/5' : ''}`}>
            <MapPin size={12} className="text-muted-foreground shrink-0" />
            <div className="flex-1">
              <p className="text-[12px] font-medium text-foreground">{r.name}</p>
              <p className="text-[10px] text-muted-foreground">{r.type} · {r.latency}ms avg</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-16 h-1 rounded-full overflow-hidden bg-white/6">
                <div className="h-full rounded-full" style={{ width: `${r.signal}%`, background: r.signal >= 90 ? '#2ecc71' : r.signal >= 70 ? '#f0a500' : '#e05252', opacity: 0.7 }} />
              </div>
              <span className={`text-[10px] font-semibold ${signalBar(r.signal)}`}>{r.signal}%</span>
            </div>
          </div>
        ))}
      </div>
      </div>
    </RenderGuard>
  );
}