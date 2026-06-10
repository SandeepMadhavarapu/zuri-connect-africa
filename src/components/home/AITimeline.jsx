import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck, ShieldAlert, TrendingDown,
  AlertTriangle, CheckCircle2, ArrowRight, Clock,
} from 'lucide-react';
import { getRecentThreats } from '@/lib/scamTelemetry';
import { AI_BRAND } from '@/lib/branding/aiBrand';

const STATIC_TIMELINE = [
  {
    id: 't1',
    icon: ShieldCheck,
    color: 'text-primary',
    bg: 'bg-primary/10',
    title: 'Sample Scam Shield event',
    sub: 'Preview security signal for review',
    time: 'Just now',
    path: '/security',
  },
  {
    id: 't2',
    icon: TrendingDown,
    color: 'text-blue-400',
    bg: 'bg-blue-400/10',
    title: 'Sample activity event',
    sub: 'Group savings preview signal',
    time: '1 hour ago',
    path: '/history',
  },
  {
    id: 't3',
    icon: CheckCircle2,
    color: 'text-primary',
    bg: 'bg-primary/10',
    title: 'Sample treasury event',
    sub: 'Chama contribution preview record',
    time: 'Yesterday',
    path: '/history',
  },
];

const LIMIT = 4;

export default function AITimeline() {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  // Merge live scam telemetry
  const threats = getRecentThreats(3).map((t, i) => ({
    id: `threat_${i}`,
    icon: t.eventType === 'fraud_blocked' ? ShieldAlert : AlertTriangle,
    color: t.eventType === 'fraud_blocked' ? 'text-red-400' : 'text-amber-400',
    bg: t.eventType === 'fraud_blocked' ? 'bg-red-400/10' : 'bg-amber-400/10',
    title: t.eventType === 'fraud_blocked' ? 'Scam blocked' : 'Fraud warning shown',
    sub: `${t.scamCategory || 'Suspicious'} pattern · ${t.amountBand ? `KSh ${t.amountBand}` : ''}`,
    time: t.timestamp ? new Date(t.timestamp).toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' }) : '',
    path: '/security',
  }));

  const timeline = [...threats, ...STATIC_TIMELINE];
  const visible = expanded ? timeline : timeline.slice(0, LIMIT);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest">{AI_BRAND.name} timeline</p>
        <button onClick={() => navigate('/ai')} className="flex items-center gap-1 text-primary text-xs font-medium">
          {AI_BRAND.name} <ArrowRight size={11} />
        </button>
      </div>

      <div className="glass-card rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
        {visible.map((item, i) => {
          const Icon = item.icon;
          return (
            <motion.button
              key={item.id}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              onClick={() => navigate(item.path)}
              className={`flex items-center gap-3 px-4 py-3 w-full text-left active:bg-white/4 transition-all ${i < visible.length - 1 ? 'border-b border-white/5' : ''}`}
            >
              <div className={`w-8 h-8 rounded-xl ${item.bg} flex items-center justify-center shrink-0`}>
                <Icon size={13} className={item.color} />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-semibold text-foreground leading-tight">{item.title}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{item.sub}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Clock size={9} className="text-muted-foreground/50" />
                <span className="text-[10px] text-muted-foreground">{item.time}</span>
              </div>
            </motion.button>
          );
        })}

        {timeline.length > LIMIT && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="w-full py-2.5 text-[11px] text-primary font-semibold border-t border-white/5 text-center"
          >
            {expanded ? 'Show less' : `Show ${timeline.length - LIMIT} more`}
          </button>
        )}
      </div>
    </div>
  );
}
