import { Wifi, Phone } from 'lucide-react';

export default function BundleStatus() {
  return (
    <div className="grid grid-cols-2 gap-3">
      <StatusCard icon={Wifi} label="Data Remaining" value="2.4 GB" subtitle="of 5 GB · 4 days left" pct={48} barColor="#2ecc71" />
      <StatusCard icon={Phone} label="Airtime" value="KSh 45" subtitle="Running low" pct={15} barColor="#f0a500" warn />
    </div>
  );
}

function StatusCard({ icon: Icon, label, value, subtitle, pct, barColor, warn }) {
  return (
    <div className="glass-card rounded-2xl p-3.5" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          <Icon size={13} style={{ color: barColor }} />
          <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
        </div>
        {warn && <span className="text-[9px] font-semibold text-amber-400 bg-amber-400/10 px-1.5 py-0.5 rounded-full">Low</span>}
      </div>
      <p className="font-grotesk font-bold text-[17px] text-foreground leading-none">{value}</p>
      <div className="mt-2.5 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: barColor, opacity: 0.75 }} />
      </div>
      <p className="text-[10px] text-muted-foreground mt-1.5">{subtitle}</p>
    </div>
  );
}