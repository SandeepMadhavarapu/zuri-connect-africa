import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Wifi, Signal, TrendingUp, ShieldCheck, Award, AlertTriangle,
} from 'lucide-react';

// Mini ring-style progress widget
function RingWidget({ pct, color, size = 44 }) {
  const r = 16;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <circle cx="20" cy="20" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5" />
      <circle cx="20" cy="20" r={r} fill="none" stroke={color} strokeWidth="3.5"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        transform="rotate(-90 20 20)" />
    </svg>
  );
}

function Widget({ icon: Icon, iconColor, label, value, sub, pct, ringColor, warn, path, onClick }) {
  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className={`premium-card rounded-2xl p-3.5 flex flex-col gap-2 text-left w-full ${warn ? 'border-amber-400/25' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon size={12} className={iconColor} />
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
        </div>
        {warn && <AlertTriangle size={10} className="text-amber-400" />}
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="font-grotesk font-bold text-[16px] text-foreground leading-none">{value}</p>
          <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{sub}</p>
        </div>
        {pct !== undefined && <RingWidget pct={pct} color={ringColor} />}
      </div>
    </motion.button>
  );
}

export default function DynamicWidgets() {
  const navigate = useNavigate();

  const widgets = [
    {
      icon: Wifi,       iconColor: 'text-violet-400', label: 'Bundle',
      value: 'Sample',  sub: 'Preview bundle signal', pct: 48,  ringColor: '#a78bfa', warn: false,
      path: '/bundles',
    },
    {
      icon: Signal,     iconColor: 'text-primary',    label: 'Network',
      value: 'Preview', sub: 'Network signal sample',  pct: 92,  ringColor: '#2ecc71', warn: false,
      path: '/network',
    },
    {
      icon: TrendingUp, iconColor: 'text-blue-400',   label: 'Spend Pulse',
      value: '-18%',    sub: 'Sample spend trend',     pct: 62,  ringColor: '#60a5fa', warn: false,
      path: '/budget',
    },
    {
      icon: ShieldCheck, iconColor: 'text-primary',   label: 'Security',
      value: 'Protected', sub: 'Security checks active', pct: 100, ringColor: '#2ecc71', warn: false,
      path: '/security',
    },
    ...(import.meta.env.VITE_ALLOW_INTERNAL_PAGES === 'true' ? [{
      icon: Award,      iconColor: 'text-amber-400',  label: 'Rewards',
      value: 'Preview', sub: 'Rewards pilot model',    pct: 74,  ringColor: '#f0a500', warn: false,
      path: '/bonga',
    }] : []),
    {
      icon: Wifi,       iconColor: 'text-amber-400',  label: 'Airtime',
      value: 'Sample',  sub: 'Airtime signal sample',  pct: 15,  ringColor: '#f0a500', warn: true,
      path: '/airtime',
    },
  ];

  return (
    <div>
      <p className="section-title mb-3">Dashboard</p>
      <div className="grid grid-cols-2 gap-2.5">
        {widgets.map((w, i) => (
          <motion.div
            key={w.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.05, type: 'spring', stiffness: 280, damping: 24 }}
          >
            <Widget {...w} onClick={() => navigate(w.path)} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
