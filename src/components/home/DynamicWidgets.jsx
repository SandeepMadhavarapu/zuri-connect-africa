import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  Signal, TrendingUp, ShieldCheck, AlertTriangle,
} from 'lucide-react';

// Mini ring-style progress widget
function RingWidget({ pct, color, size = 44 }) {
  const r = 16;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className="shrink-0">
      <circle cx="20" cy="20" r={r} fill="none" stroke="var(--hesabu-line)" strokeWidth="3.5" />
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
      className={`hesabu-card rounded-2xl p-3.5 flex flex-col gap-2 text-left w-full ${warn ? 'border-hesabu-brass' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon size={12} className={iconColor} />
          <span className="text-[10px] font-semibold text-hesabu-muted uppercase tracking-wide">{label}</span>
        </div>
        {warn && <AlertTriangle size={10} className="text-hesabu-brass" />}
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="font-display font-bold text-[16px] text-hesabu-paper leading-none">{value}</p>
          <p className="text-[10px] text-hesabu-muted mt-1 leading-relaxed">{sub}</p>
        </div>
        {pct !== undefined && <RingWidget pct={pct} color={ringColor} />}
      </div>
    </motion.button>
  );
}

export default function DynamicWidgets() {
  const navigate = useNavigate();

  // Ring + icon accents collapsed into the Hesabu palette: emerald for the
  // healthy/trust widgets, muted for the neutral activity trend.
  const EMERALD = 'var(--hesabu-emerald)';
  const MUTED = 'var(--hesabu-muted)';
  const widgets = [
    {
      icon: Signal,     iconColor: 'text-hesabu-emerald', label: 'Network',
      value: 'Preview', sub: 'Network signal sample',  pct: 92,  ringColor: EMERALD, warn: false,
      path: '/network',
    },
    {
      icon: TrendingUp, iconColor: 'text-hesabu-muted',   label: 'Activity',
      value: '-18%',    sub: 'Sample activity trend',  pct: 62,  ringColor: MUTED, warn: false,
      path: '/history',
    },
    {
      icon: ShieldCheck, iconColor: 'text-hesabu-emerald', label: 'Security',
      value: 'Protected', sub: 'Security checks active', pct: 100, ringColor: EMERALD, warn: false,
      path: '/security',
    },
  ];

  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-hesabu-paper/75 mb-3">Dashboard</p>
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
